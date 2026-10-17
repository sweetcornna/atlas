// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P36.2 on the real Gemini CLI, Qwen Code and opencode, when asked for:
 * `QM_TEST_REAL_ACP=1` and `QM_TEST_GEMINI_BIN` / `QM_TEST_QWEN_BIN` /
 * `QM_TEST_OPENCODE_BIN` (each skipped without its binary; Gemini and Qwen
 * need Node.js on PATH). Each harness starts with what the pool generates,
 * against a loopback stand-in for its lane's gateway, and runs turns
 * through the ACP channel: the node's update check, a host tool through the
 * real `qm runtime-mcp` bridge, a write the posture refuses (nothing is
 * written), and a new process that continues the conversation.
 *
 * Nothing reaches a real model or the user's own harness state: the node's
 * config root is a temp directory and each harness gets the agent's home
 * there as its home, and a fake key.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { runtimeSpec } from '../../src/host/runtimes/catalog.js'
import {
  type ExternalAgent,
  ExternalRuntimePool,
} from '../../src/host/runtimes/pool.js'
import { runtimeSmoke } from '../../src/host/runtimes/smoke.js'
import { isolatedRoot } from '../providers/fake.js'

const REAL = process.env.QM_TEST_REAL_ACP === '1'
const BINS: Record<string, string | undefined> = {
  gemini: process.env.QM_TEST_GEMINI_BIN,
  qwen: process.env.QM_TEST_QWEN_BIN,
  opencode: process.env.QM_TEST_OPENCODE_BIN,
}
/** Optional: a directory the runs' evidence is written to. */
const EVIDENCE = process.env.QM_TEST_ACP_EVIDENCE

function record(name: string, value: unknown): void {
  if (EVIDENCE === undefined) return
  mkdirSync(EVIDENCE, { recursive: true })
  writeFileSync(join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`)
}

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const step of cleanup.reverse()) await step()
  cleanup = []
})

type Reply = { tool: string; args: Record<string, unknown> } | { text: string }

interface Served {
  readonly path: string
  readonly tools: string[]
  readonly body: Record<string, unknown>
}

/**
 * A gateway for the OpenAI Chat and Gemini lanes. `reply` sees the request
 * (tool names, the whole body as text) and picks the next step; requests
 * offering no tools (session titles) get a short text and are not steps.
 */
function gateway(reply: (tools: string[], text: string) => Reply): {
  url: string
  served: Served[]
} {
  const served: Served[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >
      const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? (value as Record<string, unknown>[]) : []
      const gemini = path.includes(':streamGenerateContent')
      const tools = gemini
        ? list(body.tools).flatMap(tool =>
            list(tool.functionDeclarations).map(one => String(one.name)),
          )
        : list(body.tools).map(tool =>
            String((tool.function as Record<string, unknown>)?.name),
          )
      served.push({ path, tools, body })
      const answer: Reply =
        tools.length === 0
          ? { text: 'title' }
          : reply(tools, JSON.stringify(gemini ? body.contents : body.messages))
      const name =
        'tool' in answer
          ? (tools.find(tool => tool === answer.tool) ??
            tools.find(tool => tool.endsWith(answer.tool)))
          : undefined
      const sse = (events: unknown[], done: boolean) =>
        new Response(
          events
            .map(event => `data: ${JSON.stringify(event)}\n\n`)
            .concat(done ? ['data: [DONE]\n\n'] : [])
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      const args = 'tool' in answer ? answer.args : {}
      const text = 'text' in answer ? answer.text : 'no such tool'
      if (gemini)
        return sse(
          [
            {
              candidates: [
                {
                  index: 0,
                  content: {
                    role: 'model',
                    parts: [
                      name === undefined
                        ? { text }
                        : { functionCall: { name, args } },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 5,
                cachedContentTokenCount: 40,
                totalTokenCount: 105,
              },
            },
          ],
          false,
        )
      const base = { id: 'chatcmpl-real', object: 'chat.completion.chunk' }
      const delta =
        name === undefined
          ? { content: text }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${served.length}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
      return sse(
        [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: name === undefined ? 'stop' : 'tool_calls',
              },
            ],
          },
          {
            ...base,
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 5,
              total_tokens: 105,
              prompt_tokens_details: { cached_tokens: 40 },
            },
          },
        ],
        true,
      )
    },
  })
  cleanup.push(async () => {
    await server.stop(true)
  })
  return { url: `http://127.0.0.1:${server.port}`, served }
}

/** Each harness's write tool and its arguments for `path`. */
const WRITES: Record<string, (path: string) => Reply> = {
  gemini: path => ({
    tool: 'write_file',
    args: { file_path: path, content: 'refused\n' },
  }),
  qwen: path => ({
    tool: 'write_file',
    args: { file_path: path, content: 'refused\n' },
  }),
  opencode: path => ({
    tool: 'write',
    args: { filePath: path, content: 'refused\n' },
  }),
}

for (const id of ['gemini', 'qwen', 'opencode']) {
  const bin = REAL ? BINS[id] : undefined
  test.skipIf(bin === undefined)(
    `${id}: the update check, a host tool, a refused write and a resumed conversation through the ACP channel`,
    async () => {
      const root = isolatedRoot()
      cleanup.push(async () => root.dispose())
      const spec = runtimeSpec(id)!
      // The node's update check: a whole turn with the real bridge.
      expect(await runtimeSmoke(id, bin!)).toBeNull()

      const workspace = realpathSync(
        mkdtempSync(join(tmpdir(), `qm-real-${id}-`)),
      )
      cleanup.push(async () =>
        rmSync(workspace, { recursive: true, force: true }),
      )
      writeFileSync(join(workspace, 'README.md'), 'hello\n')
      const refused = join(workspace, 'refused.txt')
      // One tool step per prompt, then text.
      const stepped = new Set<string>()
      const once = (phase: string, step: Reply): Reply => {
        if (stepped.has(phase)) return { text: 'done' }
        stepped.add(phase)
        return step
      }
      const fake = gateway((_tools, text) => {
        if (text.includes('Resume check'))
          return { text: text.includes(`from ${id}`) ? 'resumed' : 'lost' }
        if (text.includes('Write check'))
          return once('write', WRITES[id]!(refused))
        return once('notify', {
          tool: 'qianmo_notify',
          args: { kind: 'task', severity: 'info', summary: `from ${id}` },
        })
      })
      const announced: Record<string, unknown>[] = []
      const asked: string[] = []
      const agent: ExternalAgent = {
        agent: 'coder',
        cwd: workspace,
        runtime: id,
      }
      const pool = new ExternalRuntimePool({
        agents: [agent],
        resolveLaunch: () => ({
          model: `vendor/${id}-model`,
          baseUrl:
            spec.lanes[0] === 'gemini'
              ? `${fake.url}/v1beta`
              : `${fake.url}/v1`,
          apiKey: `sk-fake-${id}`,
          lane: spec.lanes[0]!,
        }),
        bins: { [id]: bin! },
        memoryRoot: join(root.root, 'memory'),
        spawn: input => {
          const child = spawn(input.argv[0]!, input.argv.slice(1), {
            cwd: input.cwd,
            env: input.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          if (EVIDENCE !== undefined) {
            mkdirSync(EVIDENCE, { recursive: true })
            child.stderr?.on('data', (chunk: Buffer) =>
              appendFileSync(join(EVIDENCE, `${id}-stderr.log`), chunk),
            )
          }
          return child
        },
        hostTools: {
          announce: async params => {
            announced.push(params)
            return { status: 'notified' }
          },
        },
        requestPermission: async (_sessionId, call) => {
          asked.push(call.toolName)
          return false
        },
      })
      cleanup.push(async () => {
        await pool.stop()
      })
      const session = await pool.newSession(agent)
      const usage: Record<string, unknown>[] = []
      const port = new OmpResidentTurnPort(pool, {
        onUsage: (_input, one) => usage.push({ ...one }),
      })
      const run = (messageId: string, prompt: string) =>
        port.execute({ sessionId: session, messageId, prompt }, async () => {})

      const notified = await run(`${id}-1`, 'Use the node: notify.')
      expect(notified).toEqual({ outcome: 'completed', content: 'done' })
      expect(announced).toHaveLength(1)
      expect(announced[0]).toMatchObject({ summary: `from ${id}` })

      const write = await run(`${id}-2`, 'Write check: write the file.')
      if (id === 'qwen')
        // Qwen ends its turn at a refused call, without a word.
        expect(write).toMatchObject({
          outcome: 'failed',
          reason: 'Model returned only empty responses',
        })
      else expect(write).toEqual({ outcome: 'completed', content: 'done' })
      expect(existsSync(refused)).toBe(false)
      // The posture refused it on this read-only node; nobody was asked.
      expect(asked).toEqual([])

      pool.closeSession(session)
      const again = await run(`${id}-3`, 'Resume check')
      record(`${id}.json`, {
        notified,
        write,
        again,
        announced,
        usage,
        requests: fake.served.map(one => ({
          path: one.path,
          tools: one.tools,
        })),
      })
      expect(again).toEqual({ outcome: 'completed', content: 'resumed' })
    },
    240_000,
  )
}
