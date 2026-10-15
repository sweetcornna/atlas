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
/** One model turn: a single tool call, or several in parallel (Responses only). */
export type ScriptedStep = ScriptedCall | readonly ScriptedCall[]
/**
 * The wire the fake model speaks. `openai-responses` answers the way OpenAI's
 * Responses API does, so omp mints the composite `call_…|fc_…` tool-call ids
 * that every OpenAI, Azure and xAI preset produces in production.
 */
export type HarnessApi = 'openai-completions' | 'openai-responses'
/** The Responses-style call id and item id of one call, shaped like OpenAI's. */
export function responsesCallIds(
  step: number,
  call = 0,
): {
  callId: string
  itemId: string
} {
  const hex = Bun.hash(`harness-${step}-${call}`).toString(16).padStart(16, '0')
  return {
    callId: `call_${`${hex}${hex}`.slice(0, 24)}`,
    itemId: `fc_${hex.repeat(3)}`,
  }
}
export class ResidentOmpHarness {
  readonly #server: ReturnType<typeof Bun.serve>
  #steps: readonly ScriptedStep[] = []
  #step = 0
  #responseGate: Promise<void> | undefined
  #releaseResponse: (() => void) | undefined
  readonly offeredTools = new Set<string>()
  readonly toolResults: string[] = []
  /** Every request body the fake model received, in order. */
  readonly requests: Record<string, unknown>[] = []
  readonly frames: OmpRpcFrame[] = []
  readonly pools: ResidentOmpPool[] = []
  constructor(options: { readonly api?: HarnessApi } = {}) {
    const api = options.api ?? 'openai-completions'
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        await this.#responseGate
        if (api === 'openai-responses') return this.#responses(request)
        const data = (await request.json()) as {
          messages: { role: string; content: unknown }[]
          tools?: { function: { name: string } }[]
        }
        this.requests.push(data)
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
        if (step !== undefined && !('name' in step))
          throw new Error('parallel calls need the openai-responses wire')
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
      `providers:\n  fake:\n    baseUrl: http://127.0.0.1:${this.#server.port}/v1\n    api: ${api}\n    apiKey: test-no-secret\n    models:\n      - id: fake-model\n        name: Fake\n        contextWindow: 65536\n        maxTokens: 4096\n`,
    )
    writeFileSync(
      join(ompAgentDir(), 'config.yml'),
      'modelRoles:\n  default: fake/fake-model\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\nretry:\n  enabled: false\n  fallbackChains: {}\n',
    )
  }
  async #responses(request: Request): Promise<Response> {
    const data = (await request.json()) as {
      input?: Record<string, unknown>[]
      tools?: { name?: string }[]
    }
    this.requests.push(data)
    for (const tool of data.tools ?? [])
      if (typeof tool.name === 'string') this.offeredTools.add(tool.name)
    // Parallel calls come back as a run of outputs at the end of the input.
    const input = data.input ?? []
    let first = input.length
    while (input[first - 1]?.type === 'function_call_output') first--
    for (const { output } of input.slice(first))
      this.toolResults.push(
        typeof output === 'string' ? output : JSON.stringify(output),
      )
    const step = this.#steps[this.#step++]
    const n = this.#step
    const calls = step === undefined ? [] : 'name' in step ? [step] : step
    const items: Record<string, unknown>[] = calls.map((call, index) => {
      const { callId, itemId } = responsesCallIds(n, index)
      return {
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: call.name,
        arguments: JSON.stringify(call.input),
      }
    })
    if (items.length === 0)
      items.push({
        type: 'message',
        id: `msg_${n}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'pong', annotations: [] }],
      })
    const events = [
      {
        type: 'response.created',
        response: { id: `resp_${n}`, status: 'in_progress' },
      },
      ...items.flatMap((item, index) => [
        {
          type: 'response.output_item.added',
          output_index: index,
          item:
            item.type === 'function_call'
              ? { ...item, arguments: '' }
              : { ...item, content: [] },
        },
        item.type === 'function_call'
          ? {
              type: 'response.function_call_arguments.delta',
              output_index: index,
              item_id: item.id,
              delta: item.arguments,
            }
          : {
              type: 'response.output_text.delta',
              output_index: index,
              content_index: 0,
              delta: 'pong',
            },
        {
          type: 'response.output_item.done',
          output_index: index,
          item: { ...item, status: 'completed' },
        },
      ]),
      {
        type: 'response.completed',
        response: {
          id: `resp_${n}`,
          status: 'completed',
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]
    return new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  script(steps: readonly ScriptedStep[]): void {
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
