// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One cell of the per-preset parity table (P18.12, hermes #33; design
 * `providers-console-m1.md` §5.9 item 2, AC-P4): in a process of its own, as
 * an ACP child starts, against the settings the spawning test delivered —
 *
 * 1. `computeEffectiveProviderState()`, what the node reports (`status`);
 * 2. the first main-loop request of a fresh session, through the real
 *    `queryModelWithStreaming` (claude.ts dispatches to the lane), answered by
 *    a recording stub on `options.fetchOverride`.
 *
 * Prints one marked JSON line with both. Any other fetch is recorded as
 * stray and refused; nothing leaves the process. The key is the spawning
 * test's canary. The spawning test runs this without `NODE_ENV=test`, as an
 * ACP child runs, so the VCR layer stays out of the way.
 */
import type { Options } from '../../../../api/claude.js'
import { createUserMessage } from '../../../../../utils/messages/constructors.js'
import { shouldEnableThinkingByDefault } from '../../../../../utils/model/thinking.js'
import type { SystemPrompt } from '../../../../../utils/session/systemPromptType.js'
import { computeEffectiveProviderState } from '../../node.js'

// MACRO is a build-time define; provide it for the bare runtime (same pattern
// as src/services/api/__tests__/streamFinalization.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

type Captured = { url: string; body: unknown }

const ANTHROPIC_SSE = [
  {
    type: 'message_start',
    message: {
      id: 'msg_preset_parity',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
]
  .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join('')

const CHAT_SSE =
  'data: {"id":"chatcmpl-preset","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-preset","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

const RESPONSES_SSE =
  'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'

const GEMINI_SSE =
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1}}\n\n'

function sseFor(url: string): string {
  const path = new URL(url).pathname
  if (path.endsWith('/messages')) return ANTHROPIC_SSE
  if (path.endsWith('/chat/completions')) return CHAT_SSE
  if (path.endsWith('/responses')) return RESPONSES_SSE
  return GEMINI_SSE
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
}

async function bodyOf(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<unknown> {
  const text =
    init?.body !== undefined && init.body !== null
      ? String(init.body)
      : input instanceof Request
        ? await input.clone().text()
        : ''
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const stray: string[] = []
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
  stray.push(urlOf(input))
  return new Response('refused by preset-request.runner', { status: 418 })
}) as unknown as typeof fetch

const state = computeEffectiveProviderState()

const requests: Captured[] = []
const fetchOverride = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = urlOf(input)
  requests.push({ url, body: await bodyOf(input, init) })
  return new Response(sseFor(url), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}) as unknown as typeof fetch

const options = {
  model: state.model,
  ...(state.modelSettingsSlot === null
    ? {}
    : { modelSettingsSlot: state.modelSettingsSlot }),
  querySource: 'sdk',
  isNonInteractiveSession: true,
  agents: [],
  hasAppendSystemPrompt: false,
  mcpTools: [],
  getToolPermissionContext: async () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  }),
  fetchOverride,
} as unknown as Options

const { queryModelWithStreaming } = await import('../../../../api/claude.js')
const outputs: string[] = []
for await (const output of queryModelWithStreaming({
  messages: [createUserMessage({ content: 'hello' })],
  systemPrompt: ['You are a test.'] as unknown as SystemPrompt,
  // QueryEngine's default for a session that was given none.
  thinkingConfig:
    shouldEnableThinkingByDefault() !== false
      ? { type: 'adaptive' }
      : { type: 'disabled' },
  tools: [],
  signal: new AbortController().signal,
  options,
})) {
  const typed = output as { type: string; isApiErrorMessage?: boolean }
  outputs.push(
    typed.isApiErrorMessage === true
      ? `api_error:${JSON.stringify((output as { message?: { content?: unknown } }).message?.content)}`
      : typed.type,
  )
}

process.stdout.write(
  `QIANMO_PRESET_REQUEST ${JSON.stringify({ state, requests, stray, outputs })}\n`,
)
