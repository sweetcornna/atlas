// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { OmpResidentTurnPort, type OmpRpcFrame } from '@qianmo/resident'
import { ResidentOmpPool } from '../../../packages/node/src/host/residentOmp.js'
import { applyRequest } from '../../../packages/node/test/providers/helpers.js'
import { isolatedRoot } from '../../../packages/node/test/providers/fake.js'
import {
  stageProviderApply,
  commitPendingProviderConfig,
  readProviderState,
} from '../../../packages/node/src/providers/node.js'

export function chatStream(
  model: unknown,
  delta: Record<string, unknown>,
  finish = 'stop',
  cached = 0,
): Response {
  const base = {
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model,
  }
  return new Response(
    [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', ...delta },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4,
          total_tokens: 104,
          prompt_tokens_details: { cached_tokens: cached },
        },
      },
    ]
      .map(v => `data: ${JSON.stringify(v)}\n\n`)
      .join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
export async function providerRuntime(
  reply: (body: Record<string, unknown>, index: number) => Response = b =>
    chatStream(b.model, { content: 'OK' }),
  profile: Record<string, unknown> = {},
) {
  const fixture = isolatedRoot()
  // The workspace must not live inside the protected node configuration root.
  // Keep all fixture paths under one disposable parent, as sibling roots.
  process.env.QIANMO_CONFIG_DIR = join(fixture.root, 'config')
  mkdirSync(process.env.QIANMO_CONFIG_DIR, { mode: 0o700 })
  const workspace = join(fixture.root, 'workspace')
  mkdirSync(workspace)
  const requests: { body: Record<string, unknown>; headers: Headers }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST') return Response.json({ data: [] })
      const body = (await req.json()) as Record<string, unknown>
      requests.push({ body, headers: req.headers })
      return reply(body, requests.length - 1)
    },
  })
  const baseUrl = `http://127.0.0.1:${server.port}/v1`
  const model = {
    id: 'native-test-model',
    role: 'main',
    tiers: ['sonnet'],
    capabilities: {
      mode: 'explicit',
      thinking: false,
      adaptive_thinking: false,
      interleaved_thinking: false,
    },
    effort: { send: 'never' },
  }
  async function apply(overrides: Record<string, unknown> = {}) {
    const req = applyRequest({
      expect: {
        ownedHash: readProviderState().managed
          ? readProviderState().onDiskHash
          : null,
      },
      profile: {
        lane: 'openai-chat',
        baseUrl,
        compat: {},
        models: [model],
        ...profile,
        ...overrides,
      },
    })
    const staged = stageProviderApply(req)
    if (!staged.ok) throw new Error(JSON.stringify(staged))
    const committed = await commitPendingProviderConfig()
    if (committed.status !== 'committed')
      throw new Error(JSON.stringify(committed))
    return committed
  }
  await apply()
  const pools: ResidentOmpPool[] = []
  const frames: OmpRpcFrame[] = []
  function pool() {
    const p = new ResidentOmpPool({
      agents: [{ agent: 'reviewer', cwd: workspace }],
      memoryRoot: join(fixture.root, 'memory'),
      announce: async () => ({ status: 'queued' }),
    })
    pools.push(p)
    return p
  }
  async function turn(p: ResidentOmpPool, sessionId: string, text: string) {
    const channel = await p.channelFor(sessionId)
    const off = channel.onFrame(f => frames.push(f))
    let accepted = false
    const port = new OmpResidentTurnPort(p, {
      inactivity: { timeoutMs: 15000 },
    })
    try {
      const result = await port.execute(
        { sessionId, messageId: `message-${frames.length}`, prompt: text },
        async () => {
          accepted = true
        },
      )
      return { result, accepted }
    } finally {
      off()
    }
  }
  return {
    root: fixture.root,
    workspace,
    baseUrl,
    requests,
    frames,
    apply,
    pool,
    turn,
    async dispose() {
      await Promise.all(pools.map(p => p.stop()))
      server.stop(true)
      fixture.dispose()
    },
  }
}
