// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recording stub for the Grok lane (P18.12), the counterpart of
 * `requestCapture.ts`: drives the REAL `queryModelGrok` and answers every
 * request through `options.fetchOverride` with a constructed SSE body. The
 * key is a canary no vendor would accept; nothing leaves the process.
 *
 * Callers own the settings mock (getInitialSettings → `{}`).
 */
import { queryModelGrok } from 'src/services/api/grok/index.js'
import type { Options } from 'src/services/api/claude.js'
import type { Message } from 'src/types/message.js'
import type { SystemPrompt } from 'src/utils/session/systemPromptType.js'

const CANARY_API_KEY = 'sk-test-canary-p1812-grok-not-a-real-key'

const GROK_LANE_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'GROK_BASE_URL',
  'GROK_MAX_TOKENS',
] as const

const CHAT_SSE =
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n'

export type GrokCaptureParams = {
  model: string
  /** GROK_BASE_URL; `undefined` leaves it unset (the xAI default). */
  baseURL?: string
  env?: Record<string, string | undefined>
  messages?: Message[]
  /** Answer the first N requests with this error instead of a stream. */
  failFirst?: { status: number; body: unknown }[]
  /** SSE bodies for successive requests; the last one repeats. */
  chatSSE?: string | string[]
  outputs?: unknown[]
  signal?: AbortSignal
}

export async function captureGrokRequests(
  params: GrokCaptureParams,
): Promise<{ url: string; body: Record<string, unknown> }[]> {
  const saved = new Map<string, string | undefined>()
  for (const key of GROK_LANE_ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  const rowEnv: Record<string, string | undefined> = {
    CLAUDE_CODE_USE_GROK: '1',
    GROK_API_KEY: CANARY_API_KEY,
    GROK_BASE_URL: params.baseURL,
    ...params.env,
  }
  for (const [key, value] of Object.entries(rowEnv)) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  const failures = [...(params.failFirst ?? [])]
  const bodies = Array.isArray(params.chatSSE)
    ? [...params.chatSSE]
    : [params.chatSSE ?? CHAT_SSE]
  const captured: { url: string; body: Record<string, unknown> }[] = []
  const fetchOverride = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    const failure = failures.shift()
    if (failure) {
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    const sse = bodies.length > 1 ? bodies.shift()! : bodies[0]!
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch

  const options = {
    model: params.model,
    querySource: 'main_loop',
    agents: [],
    allowedAgentTypes: [],
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

  try {
    for await (const output of queryModelGrok(
      params.messages ?? [],
      [] as unknown as SystemPrompt,
      [],
      params.signal ?? new AbortController().signal,
      options,
    )) {
      params.outputs?.push(output)
    }
    return captured
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
