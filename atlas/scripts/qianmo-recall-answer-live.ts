// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live transport of the answer-layer executor: one OpenAI-compatible
 * Chat Completions request per round, built here and sent as built.
 *
 * `buildWireBody` is the whole request: the system block as one system
 * message, the memory tool as the one function, `max_tokens` 8192, no
 * sampling parameter of its own. A thinking-capable target (a model id
 * containing `deepseek` or `mimo`) also gets reasoning effort `low` and the
 * three thinking switches the AC-4 leg sent under the previous base, and its
 * reasoning is replayed as `reasoning_content` on the next round (backfilled
 * empty on a tool-calling turn that had none, because DeepSeek's thinking mode
 * rejects the turn without it). Because the body measured and the body sent
 * are the same object, a number measured here is a number about the request
 * that goes out. The second round carries the model's own turn, thinking
 * included, and the rejection as the tool result, the way the AC-5 leg feeds a
 * tool result back.
 *
 * Providers are the two of the AC-5 fixture (id, default model); their
 * `compatRule` does not shape the body. The endpoint and the key come from
 * `OPENAI_BASE_URL` / `OPENAI_API_KEY` only; nothing here writes either
 * anywhere, and neither errors nor the call log carry a host — only the
 * provider id.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSseJson } from '@oh-my-pi/pi-utils/stream'
import { MEMORY_ANSWER_TOOL, MEMORY_EVIDENCE_TOOL } from '@qianmo/recall'
import type {
  AnswerRequest,
  AnswerResponse,
  AnswerTransport,
  TokenUsage,
  ToolCall,
  Turn,
} from '../packages/recall/eval/answer/types.js'

const ATLAS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The AC-5 fixture: the one definition of "the two providers". */
const PROVIDERS_FIXTURE = join(
  ATLAS_ROOT,
  'tests/integration/fixtures/qianmo-providers.json',
)

/** As `askWithMemory`. */
export const MAX_TOKENS = 8192

/**
 * The OpenAI SDK's default request timeout, which bounded every call while
 * the transport went through it.
 */
const REQUEST_TIMEOUT_MS = 600_000

/** One entry of the AC-5 provider fixture. */
export type AnswerProvider = {
  readonly reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  readonly id: string
  readonly kind: 'openai-compat'
  readonly baseUrl: string
  readonly apiKeyEnv: string
  readonly defaultModel: string
  readonly compatRule?: string
}

function parseProvider(raw: unknown, index: number): AnswerProvider {
  const entry = (raw ?? {}) as Record<string, unknown>
  const text = (field: string): string => {
    const value = entry[field]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `${PROVIDERS_FIXTURE}[${index}].${field} must be a non-empty string`,
      )
    }
    return value
  }
  if (entry['kind'] !== 'openai-compat') {
    throw new Error(`${PROVIDERS_FIXTURE}[${index}].kind must be openai-compat`)
  }
  const compatRule = entry['compatRule']
  if (compatRule !== undefined && typeof compatRule !== 'string') {
    throw new Error(
      `${PROVIDERS_FIXTURE}[${index}].compatRule must be a string`,
    )
  }
  return {
    id: text('id'),
    kind: 'openai-compat',
    baseUrl: text('baseUrl'),
    apiKeyEnv: text('apiKeyEnv'),
    defaultModel: text('defaultModel'),
    ...(entry['reasoningEffort'] === undefined
      ? {}
      : { reasoningEffort: parseEffort(entry['reasoningEffort']) }),
    ...(compatRule === undefined ? {} : { compatRule }),
  }
}

function parseEffort(
  value: unknown,
): NonNullable<AnswerProvider['reasoningEffort']> {
  if (
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high' &&
    value !== 'max'
  )
    throw new Error('invalid answer model reasoning effort')
  return value
}

/** Explicit participant replacement; never changes frozen quality thresholds. */
export function answerModelProfile(): {
  providers: AnswerProvider[]
  authorization: string
} | null {
  const path = process.env.QIANMO_RECALL_EVAL_PROFILE
  if (!path) return null
  const profile = JSON.parse(readFileSync(path, 'utf8'))
  if (
    !Array.isArray(profile.providers) ||
    profile.providers.length < 1 ||
    typeof profile.authorization !== 'string' ||
    !profile.authorization
  )
    throw new Error(
      'evaluation model replacement needs participants and authorization',
    )
  return {
    providers: profile.providers.map(parseProvider),
    authorization: profile.authorization,
  }
}

export function loadProviders(): AnswerProvider[] {
  const profile = answerModelProfile()
  if (profile !== null) return profile.providers
  const raw: unknown = JSON.parse(readFileSync(PROVIDERS_FIXTURE, 'utf8'))
  if (!Array.isArray(raw)) {
    throw new Error(`${PROVIDERS_FIXTURE} must hold an array of providers`)
  }
  return raw.map(parseProvider)
}

type Credentials = { readonly apiKey: string; readonly baseURL: string }

/** The credentials, or why the live run is skipped (AC-4's gate, verbatim). */
export function liveCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Credentials | { readonly skip: string } {
  if (env.QIANMO_PROVIDER_LIVE === '0') {
    return { skip: 'QIANMO_PROVIDER_LIVE=0 —— 显式关闭了真调用' }
  }
  const apiKey = env.OPENAI_API_KEY
  const baseURL = env.OPENAI_BASE_URL
  if (!apiKey) return { skip: 'OPENAI_API_KEY 未设置' }
  if (!baseURL) return { skip: 'OPENAI_BASE_URL 未设置' }
  return { apiKey, baseURL }
}

const MEMORY_TOOL = {
  type: 'function',
  function: {
    name: MEMORY_ANSWER_TOOL.name,
    description: MEMORY_ANSWER_TOOL.description,
    parameters: MEMORY_ANSWER_TOOL.inputSchema,
  },
} as const
const MEMORY_EVIDENCE_WIRE_TOOL = {
  type: 'function',
  function: {
    name: MEMORY_EVIDENCE_TOOL.name,
    description: MEMORY_EVIDENCE_TOOL.description,
    parameters: MEMORY_EVIDENCE_TOOL.inputSchema,
  },
} as const

type WireMessage = Record<string, unknown>

/** Executor turns → Chat Completions messages, the system block first. */
function toWireMessages(
  system: readonly string[],
  turns: readonly Turn[],
  thinking: boolean,
): WireMessage[] {
  const messages: WireMessage[] = []
  const systemText = system.filter(part => part.length > 0).join('\n\n')
  if (systemText.length > 0) {
    messages.push({ role: 'system', content: systemText })
  }
  for (const turn of turns) {
    if (turn.role === 'user') {
      messages.push({ role: 'user', content: turn.text })
      continue
    }
    if (turn.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: turn.toolCallId,
        content: turn.content,
      })
      continue
    }
    const message: WireMessage = {
      role: 'assistant',
      content: turn.text.length > 0 ? turn.text : null,
    }
    // As the AC-5 leg: the reasoning is kept, because a reasoning model's
    // echo contract depends on it.
    if (turn.thinking.length > 0) {
      message['reasoning_content'] = turn.thinking
    } else if (thinking && turn.toolCalls.length > 0) {
      message['reasoning_content'] = ''
    }
    if (turn.toolCalls.length > 0) {
      message['tool_calls'] = turn.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          // An unparseable argument string is replayed as the model sent it.
          arguments:
            typeof call.input === 'string'
              ? call.input
              : JSON.stringify(call.input),
        },
      }))
    }
    messages.push(message)
  }
  return messages
}

/**
 * The request body as it goes on the wire. `baseURL` is accepted so every
 * caller states the endpoint the body is for; the body itself names none.
 */
export function buildWireBody(
  provider: AnswerProvider,
  request: Pick<AnswerRequest, 'system' | 'turns' | 'protocol'>,
  _baseURL: string,
): Record<string, unknown> {
  const model = provider.defaultModel
  // DeepSeek and MiMo models answer in thinking mode; nothing else does here.
  const thinking = /deepseek|mimo/i.test(model)
  return {
    model,
    messages: toWireMessages(request.system, request.turns, thinking),
    max_tokens: MAX_TOKENS,
    tools: [
      request.protocol === 'memory-evidence-v2'
        ? MEMORY_EVIDENCE_WIRE_TOOL
        : MEMORY_TOOL,
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(thinking && {
      reasoning_effort: 'low',
      thinking: { type: 'enabled' },
      enable_thinking: true,
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    ...(provider.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: provider.reasoningEffort }),
  }
}

/**
 * The text of a wire body a model reads: every message and the tool
 * declarations. What the dry run counts.
 */
export function modelVisibleText(wire: Record<string, unknown>): string {
  return JSON.stringify([wire['messages'], wire['tools']])
}

/**
 * An upper bound on the input tokens of a request: its UTF-8 byte length. A
 * byte-level BPE token covers at least one byte, and the JSON punctuation of
 * the body outweighs a chat template's special tokens.
 */
export function wireByteLength(wire: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(wire), 'utf8')
}

/** The parts of a Chat Completions stream chunk this transport reads. */
type Chunk = {
  readonly model?: unknown
  readonly usage?: {
    readonly prompt_tokens?: unknown
    readonly completion_tokens?: unknown
  } | null
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown
      readonly reasoning_content?: unknown
      readonly reasoning?: unknown
      readonly tool_calls?: readonly {
        readonly index?: unknown
        readonly id?: unknown
        readonly function?: {
          readonly name?: unknown
          readonly arguments?: unknown
        }
      }[]
    }
    readonly finish_reason?: unknown
  }[]
}

/** OpenAI `finish_reason` → the stop reason the report has always recorded. */
function stopReasonOf(finishReason: string, hasToolCalls: boolean): string {
  if (finishReason === 'length') return 'max_tokens'
  if (hasToolCalls || finishReason === 'tool_calls') return 'tool_use'
  return 'end_turn'
}

/** Text, thinking, tool calls, model id and usage out of the raw stream. */
export async function assembleStream(
  chunks: AsyncIterable<Chunk>,
  providerId: string,
): Promise<AnswerResponse> {
  let model: string | null = null
  let usage: TokenUsage | null = null
  let sawUsage = false
  let text = ''
  let thinking = ''
  let finishReason: string | null = null
  const buffers = new Map<number, { id: string; name: string; args: string }>()
  for await (const chunk of chunks) {
    if (typeof chunk.model === 'string' && chunk.model.length > 0) {
      model = chunk.model
    }
    if (chunk.usage) {
      sawUsage = true
      const input = chunk.usage.prompt_tokens
      const output = chunk.usage.completion_tokens
      usage =
        Number.isInteger(input) && Number.isInteger(output)
          ? { input: input as number, output: output as number }
          : null
    }
    const choice = chunk.choices?.[0]
    if (choice === undefined) continue
    const delta = choice.delta
    if (typeof delta?.content === 'string') text += delta.content
    if (typeof delta?.reasoning_content === 'string') {
      thinking += delta.reasoning_content
    } else if (typeof delta?.reasoning === 'string') {
      thinking += delta.reasoning
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0
      const buffer = buffers.get(index) ?? { id: '', name: '', args: '' }
      if (typeof call.id === 'string' && call.id.length > 0) buffer.id = call.id
      if (typeof call.function?.name === 'string') {
        buffer.name += call.function.name
      }
      if (typeof call.function?.arguments === 'string') {
        buffer.args += call.function.arguments
      }
      buffers.set(index, buffer)
    }
    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason
    }
  }
  const sawOutput = text.length > 0 || thinking.length > 0 || buffers.size > 0
  if (finishReason === null) {
    // Gateways that end on a usage chunk instead of a finish_reason.
    if (!(sawOutput && sawUsage)) {
      throw new Error(`${providerId}: stream ended before finish_reason`)
    }
    finishReason = 'stop'
  }
  // A zero-output `length` is a max_tokens outcome, not an empty answer.
  if (!sawOutput && finishReason !== 'length') {
    const reason =
      finishReason.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown'
    throw new Error(
      `${providerId}: model returned an empty response (finish_reason=${reason})`,
    )
  }
  const toolCalls = [...buffers.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, buffer]): ToolCall => {
      let input: unknown = {}
      if (buffer.args.trim().length > 0) {
        try {
          input = JSON.parse(buffer.args)
        } catch {
          // Unparseable arguments are the model's answer, not a transport
          // failure: `parseMemoryAnswerArgs` rejects them as bad arguments.
          input = buffer.args
        }
      }
      return { id: buffer.id, name: buffer.name, input }
    })
  return {
    model,
    text,
    thinking,
    toolCalls,
    stopReason: stopReasonOf(finishReason, toolCalls.length > 0),
    usage,
  }
}

export function createLiveTransport(
  provider: AnswerProvider,
  credentials: Credentials,
  options: { readonly fetch?: typeof fetch } = {},
): AnswerTransport {
  const send = options.fetch ?? fetch
  const url = `${credentials.baseURL.replace(/\/+$/, '')}/chat/completions`
  const wireOf = (request: AnswerRequest) => {
    if (request.protocol !== 'memory-evidence-v2')
      throw new Error(
        'live answer transport requires the current memory-evidence-v2 protocol; legacy v1 is replay-only',
      )
    return buildWireBody(provider, request, credentials.baseURL)
  }
  return {
    providerId: provider.id,
    requestedModel: provider.defaultModel,
    maxOutputTokens: MAX_TOKENS,
    inputUpperBound: request => wireByteLength(wireOf(request)),
    send: async request => {
      const response = await send(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify(wireOf(request)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok || response.body === null) {
        await response.body?.cancel()
        throw new Error(`${provider.id}: HTTP ${response.status}`)
      }
      return assembleStream(readSseJson<Chunk>(response.body), provider.id)
    },
  }
}
