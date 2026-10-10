// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ompAgentDir } from '@qianmo/paths'
import { OmpResidentTurnPort, type OmpRpcFrame } from '@qianmo/resident'
import { ResidentOmpPool } from '../../../packages/node/src/host/residentOmp.js'

export interface ScriptedCall {
  readonly name: string
  readonly input: Record<string, unknown>
}
export class ResidentOmpHarness {
  readonly #server: ReturnType<typeof Bun.serve>
  #steps: readonly ScriptedCall[] = []
  #step = 0
  #responseGate: Promise<void> | undefined
  #releaseResponse: (() => void) | undefined
  readonly offeredTools = new Set<string>()
  readonly toolResults: string[] = []
  readonly frames: OmpRpcFrame[] = []
  readonly pools: ResidentOmpPool[] = []
  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        await this.#responseGate
        const data = (await request.json()) as {
          messages: { role: string; content: unknown }[]
          tools?: { function: { name: string } }[]
        }
        for (const tool of data.tools ?? [])
          this.offeredTools.add(tool.function.name)
        const last = data.messages.at(-1)
        if (last?.role === 'tool')
          this.toolResults.push(
            typeof last.content === 'string'
              ? last.content
              : JSON.stringify(last.content),
          )
        const step = this.#steps[this.#step++]
        const delta = step
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${this.#step}`,
                  type: 'function',
                  function: {
                    name: step.name,
                    arguments: JSON.stringify(step.input),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'pong' }
        const base = {
          id: `chatcmpl-${this.#step}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake-model',
        }
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: step ? 'tool_calls' : 'stop',
              },
            ],
          },
          {
            ...base,
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ]
        return new Response(
          `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )
      },
    })
    mkdirSync(ompAgentDir(), { recursive: true })
    writeFileSync(
      join(ompAgentDir(), 'models.yml'),
      `providers:\n  fake:\n    baseUrl: http://127.0.0.1:${this.#server.port}/v1\n    api: openai-completions\n    apiKey: test-no-secret\n    models:\n      - id: fake-model\n        name: Fake\n        contextWindow: 65536\n        maxTokens: 4096\n`,
    )
    writeFileSync(
      join(ompAgentDir(), 'config.yml'),
      'modelRoles:\n  default: fake/fake-model\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\nretry:\n  enabled: false\n  fallbackChains: {}\n',
    )
  }
  script(steps: readonly ScriptedCall[]): void {
    this.#steps = steps
    this.#step = 0
  }
  pauseResponses(): () => void {
    this.#responseGate = new Promise(resolve => {
      this.#releaseResponse = resolve
    })
    return () => {
      this.#releaseResponse?.()
      this.#responseGate = undefined
    }
  }
  async run(
    workspace: string,
    steps: readonly ScriptedCall[],
    edits = false,
    memoryRoot = join(workspace, '..', 'memory'),
  ) {
    this.#steps = steps
    this.#step = 0
    this.toolResults.length = 0
    this.frames.length = 0
    const pool = new ResidentOmpPool({
      agents: [{ agent: 'reviewer', cwd: workspace }],
      memoryRoot,
      allowWorkspaceEdits: edits,
      announce: async () => ({ status: 'queued' }),
    })
    this.pools.push(pool)
    const sessionId = await pool.newSession({
      agent: 'reviewer',
      cwd: workspace,
    })
    const channel = await pool.channelFor(sessionId)
    channel.onFrame(frame => this.frames.push(frame))
    const turn = new OmpResidentTurnPort(pool, {
      inactivity: { timeoutMs: 10_000 },
    })
    let accepted = false
    const messageId = `input-${Date.now()}`
    const result = await turn.execute(
      { sessionId, messageId, prompt: 'Run the scripted acceptance case.' },
      async () => {
        accepted = true
      },
    )
    return {
      result,
      accepted,
      messageId,
      sessionId,
      pool,
      toolResults: [...this.toolResults],
      frames: [...this.frames],
    }
  }
  async stop(): Promise<void> {
    this.#releaseResponse?.()
    await Promise.all(this.pools.map(pool => pool.stop()))
    await this.#server.stop(true)
  }
}
