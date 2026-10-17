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
 * state: the runtimes get the node's own homes under the test config root, a
 * scratch `HOME` and a fake key; the file refuses to run with a config root
 * under the real home (P36.7). Connectors reach the runtimes as `qm-<name>`.
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeExtensions } from '../../src/host/extensions.js'
import type { ExternalRuntimeKind } from '../../src/host/runtimes/channel.js'
import {
  type ExternalAgent,
  ExternalRuntimePool,
} from '../../src/host/runtimes/pool.js'
import type { NativeExtensionsReply } from '../../src/host/runtimes/contract.js'
import { NativeExtensions } from '../../src/host/runtimes/nativeExt.js'
import { runtimeDirs } from '../../src/host/runtimes/runtimeEnv.js'
import { runtimeSmoke } from '../../src/host/runtimes/smoke.js'
import { assertScratchConfigRoot, REAL_HOME } from './realHarnessGuard.js'

const CLAUDE = Bun.which('claude')
const CODEX = Bun.which('codex')
const TINY = join(import.meta.dir, 'fixtures', 'tiny-mcp.runner.ts')

interface Seen {
  readonly path: string
  readonly body: Record<string, unknown>
}

// Real harnesses write where the config root says: never the user's own.
beforeAll(assertScratchConfigRoot)

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
async function node(
  runtime: ExternalRuntimeKind,
  url: string,
  options: {
    readonly approval?: 'allow' | 'ask'
    readonly permission?: (toolName: string) => boolean
  } = {},
) {
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
  const home = process.env.HOME
  process.env.PATH = `${bin}:${path}`
  // The harnesses' own HOME too: nothing of the user's `~/.agents` and such.
  process.env.HOME = join(root, 'home')
  mkdirSync(process.env.HOME)
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
      approval: options.approval ?? 'allow',
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
  const asked: string[] = []
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
    requestPermission: async (_sessionId, call) => {
      asked.push(call.toolName)
      return options.permission?.(call.toolName) ?? false
    },
  })
  cleanup.push(async () => {
    await pool.stop()
    await extensions.close()
    process.env.PATH = path
    process.env.HOME = home
    rmSync(root, { recursive: true, force: true })
  })
  const sessionId = await pool.newSession(agent)
  const turn = () =>
    new OmpResidentTurnPort(pool).execute(
      { sessionId, messageId: 'real-1', prompt: 'Use the docs.' },
      async () => {},
    )
  return { turn, asked, root, workspace }
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
          name: 'mcp__qm-docs__search',
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
    expect(tools).toContain('mcp__qm-docs__search')
    expect(tools).toContain('Skill')
    expect(JSON.stringify(first.body)).toContain('qianmo:review')
    expect(JSON.stringify(first.body)).not.toContain(join(REAL_HOME, '.agents'))
    // The operator's server ran, with its own variable.
    expect(JSON.stringify(turns.at(-1)!.body)).toContain(
      'found: cache (token-1)',
    )
  },
  120_000,
)

test.skipIf(CLAUDE === null)(
  'Claude Code: a call on a server set to ask goes through qianmo_permission to the operator, every time',
  async () => {
    const fake = model((path, body) => {
      if (!path.endsWith('/messages')) return Response.json({ input_tokens: 1 })
      const results = JSON.stringify(body.messages ?? []).split(
        '"tool_result"',
      ).length
      // Two calls in one turn: each one is asked about.
      if (results <= 2)
        return anthropic({
          type: 'tool_use',
          id: `toolu_docs_${results}`,
          name: 'mcp__qm-docs__search',
          input: { q: `cache-${results}` },
        })
      return anthropic({ type: 'text', text: 'done' })
    })
    const { turn, asked } = await node('claude-code', fake.url, {
      approval: 'ask',
      permission: tool => tool === 'mcp__docs__search',
    })
    expect(await turn()).toEqual({ outcome: 'completed', content: 'done' })
    expect(asked).toEqual(['mcp__docs__search', 'mcp__docs__search'])
    const last = JSON.stringify(
      fake.seen.filter(one => one.path.endsWith('/messages')).at(-1)!.body,
    )
    expect(last).toContain('found: cache-1 (token-1)')
    expect(last).toContain('found: cache-2 (token-1)')
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
          // Codex shows the model `qm-docs` as `qm_docs`.
          namespace: 'mcp__qm_docs',
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
    expect(namespaces).toContain('mcp__qm_docs')
    expect(first).toContain('qianmo_notify')
    // Codex also lists its own bundled skills and those under the node
    // account's `~/.agents/skills`, as qianmopi does (whether a resident agent
    // keeps user-level skills is P14.0's open question); this checks only
    // that the operator's skill is there.
    expect(first).toContain('qianmo:review')
    // The operator's server ran, with its own variable.
    expect(JSON.stringify(turns.at(-1)!.body.input)).toContain(
      'found: cache (token-1)',
    )
  },
  120_000,
)

test.skipIf(CLAUDE === null)(
  'Claude Code: a server added with its own `claude mcp add` loads headless and is the operator’s call; a native hook never fires (P36.7)',
  async () => {
    const fake = model((path, body) => {
      if (!path.endsWith('/messages')) return Response.json({ input_tokens: 1 })
      if (!JSON.stringify(body.messages ?? []).includes('"tool_result"'))
        return anthropic({
          type: 'tool_use',
          id: 'toolu_own',
          name: 'mcp__own__search',
          input: { q: 'native' },
        })
      return anthropic({ type: 'text', text: 'done' })
    })
    const { turn, asked, root, workspace } = await node(
      'claude-code',
      fake.url,
      { permission: tool => tool === 'mcp__own__search' },
    )
    // Hooks the agent's own settings carry: the pin layer keeps them off.
    const marker = join(root, 'hook-fired')
    const home = runtimeDirs('claude-code', 'coder').home
    mkdirSync(home, { recursive: true })
    const hook = [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }]
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: hook,
          PreToolUse: [{ matcher: '.*', ...hook[0] }],
        },
      }),
    )
    // The console's native operation: Claude Code's own command.
    const native = new NativeExtensions({
      agents: [{ agent: 'coder', cwd: workspace }],
      runtimeOf: () => 'claude-code',
      bins: { 'claude-code': CLAUDE! },
    })
    const added = await native.control(
      'runtime.ext.install',
      {
        agent: 'coder',
        kind: 'mcp',
        name: 'own',
        source: 'tiny-mcp',
        command: 'tiny-mcp',
      },
      {} as never,
    )
    expect(added).toMatchObject({ ok: true })
    expect(
      (added as { value: NativeExtensionsReply }).value.items,
    ).toContainEqual({ kind: 'mcp', name: 'own', enabled: true })
    expect(await turn()).toEqual({ outcome: 'completed', content: 'done' })
    const first = fake.seen.find(
      one =>
        one.path.endsWith('/messages') &&
        Array.isArray(one.body.tools) &&
        (one.body.tools as unknown[]).length > 0,
    )!
    expect(
      (first.body.tools as { name: string }[]).map(one => one.name),
    ).toContain('mcp__own__search')
    // Not a connector: the operator decided, and the server ran.
    expect(asked).toEqual(['mcp__own__search'])
    expect(
      JSON.stringify(
        fake.seen.filter(one => one.path.endsWith('/messages')).at(-1)!.body,
      ),
    ).toContain('found: native')
    expect(existsSync(marker)).toBe(false)
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
