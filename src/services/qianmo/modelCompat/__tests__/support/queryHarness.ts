// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Drives the real `query()` loop over the real `queryModelOpenAI` (P18.12):
 * for behaviour that lives in `query.ts` (model fallback, the output-limit
 * recovery) and needs a lane underneath that answers like one. Every request
 * goes to `fetchOverride`; anything that reaches the global `fetch` instead
 * (a side query building its own client) is recorded in `stray` and answered
 * with a 418, so nothing leaves the process.
 *
 * Callers own the settings mock and the lane env (CLAUDE_CODE_USE_OPENAI,
 * OPENAI_BASE_URL, …); set CLAUDE_CODE_DISABLE_AUTO_MEMORY and
 * CLAUDE_CODE_DISABLE_ATTACHMENTS so no side query runs.
 */
import { query } from 'src/query.js'
import { queryModelOpenAI } from 'src/services/api/openai/index.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import { asSystemPrompt } from 'src/utils/session/systemPromptType.js'

function toolUseContext(model: string) {
  let appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    fastMode: false,
    mcp: { tools: [], clients: [] },
    effortValue: undefined,
    advisorModel: undefined,
    sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: model,
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState: (updater: (state: typeof appState) => typeof appState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

type CallModelParams = {
  messages: Message[]
  systemPrompt: Parameters<typeof queryModelOpenAI>[1]
  tools: Parameters<typeof queryModelOpenAI>[2]
  signal: AbortSignal
  options: Parameters<typeof queryModelOpenAI>[4]
}

export async function runQueryOverOpenAILane(params: {
  model: string
  history: Message[]
  fetchOverride: typeof fetch
  fallbackModels?: string[]
}): Promise<{
  emitted: unknown[]
  stray: string[]
  mainLoopModel: string
  /** `options.maxOutputTokensOverride` of each lane call, in order. */
  overrides: (number | undefined)[]
}> {
  const stray: string[] = []
  const overrides: (number | undefined)[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    stray.push(String(input))
    return new Response('{}', { status: 418 })
  }) as unknown as typeof fetch
  const context = toolUseContext(params.model)
  const emitted: unknown[] = []
  try {
    for await (const message of query({
      messages: params.history,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool: async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      toolUseContext: context as never,
      fallbackModels: params.fallbackModels,
      querySource: 'sdk',
      deps: {
        uuid: () => 'p1812-query-harness',
        microcompact: async (messages: unknown[]) => ({ messages }),
        autocompact: async () => ({
          compactionResult: undefined,
          consecutiveFailures: 0,
        }),
        callModel: (call: CallModelParams) => {
          overrides.push(call.options.maxOutputTokensOverride)
          return queryModelOpenAI(
            call.messages,
            call.systemPrompt,
            call.tools,
            call.signal,
            { ...call.options, fetchOverride: params.fetchOverride },
          )
        },
      } as never,
    })) {
      emitted.push(message)
    }
  } finally {
    globalThis.fetch = realFetch
  }
  return {
    emitted,
    stray,
    mainLoopModel: context.options.mainLoopModel,
    overrides,
  }
}

/** Text of every assistant and system message emitted, in order. */
export function emittedTexts(emitted: readonly unknown[]): string[] {
  return emitted.flatMap(message => {
    const m = message as {
      type?: string
      content?: unknown
      message?: { content?: { type: string; text?: string }[] }
    }
    if (m.type === 'system' && typeof m.content === 'string') return [m.content]
    if (m.type === 'assistant') {
      return (m.message?.content ?? []).map(block => block.text ?? '')
    }
    return []
  })
}
