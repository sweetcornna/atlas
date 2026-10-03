// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #4 — reasoning replay decided by the target endpoint (P18.8).
 *
 * Fixtures are constructed, not recorded: the conversation shapes follow the
 * cases named in hermes `agent/message_sanitization.py:714-850` (strict side
 * stripped, require side padded, `""` upgraded) and hermes-research §11.9-①
 * E/F, the two probes this package has to flip. No vendor was called.
 */
import { describe, expect, test } from 'bun:test'
import {
  anthropicMessagesToOpenAI,
  type AssistantMessage,
  type UserMessage,
} from '@ant/model-provider'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions.mjs'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import {
  applyReasoningReplayPolicy,
  reasoningEchoFamily,
} from '../reasoningEcho.js'

function user(content: string): UserMessage {
  return {
    type: 'user',
    uuid: `u-${content}`,
    message: { role: 'user', content },
  } as unknown as UserMessage
}

function assistant(id: string, content: unknown[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `a-${id}`,
    message: { id, role: 'assistant', content },
  } as unknown as AssistantMessage
}

function bodyFor(params: {
  model: string
  baseURL: string | undefined
  history: (UserMessage | AssistantMessage)[]
  enableThinking: boolean
}): Record<string, unknown>[] {
  const body = buildOpenAIRequestBody({
    model: params.model,
    messages: anthropicMessagesToOpenAI(params.history, [] as never, {
      enableThinking: params.enableThinking,
    }),
    tools: [],
    toolChoice: undefined,
    enableThinking: params.enableThinking,
    maxTokens: 1024,
    baseURL: params.baseURL,
  })
  return (body.messages as unknown as Record<string, unknown>[]).filter(
    m => m.role === 'assistant',
  )
}

describe('reasoningEchoFamily — hermes _REASONING_ECHO_RULES', () => {
  test.each([
    ['kimi-k3', 'https://api.moonshot.cn/v1', 'kimi'],
    ['kimi-k3', 'https://api.moonshot.ai/v1', 'kimi'],
    ['k3', 'https://api.kimi.com/coding/v1', 'kimi'],
    ['anything', 'https://api.moonshot.ai/v1', 'kimi'],
    ['deepseek-v4-pro', 'https://gateway.example/v1', 'deepseek'],
    ['renamed-checkpoint', 'https://api.deepseek.com', 'deepseek'],
    ['mimo-v2.6-pro', 'https://gateway.example/v1', 'mimo'],
    ['renamed', 'https://api.xiaomimimo.com/v1', 'mimo'],
    ['renamed', 'https://token-plan-cn.xiaomimimo.com/v1', 'mimo'],
  ] as const)('%s @ %s → %s', (model, baseURL, family) => {
    expect(reasoningEchoFamily(model, baseURL)).toBe(family)
  })

  test.each([
    // Kimi is host-driven: an aggregator re-exporting the model is strict.
    ['moonshotai/kimi-k3', 'https://openrouter.ai/api/v1'],
    ['kimi-k3', 'https://gateway.example/v1'],
    ['mistral-large-latest', 'https://api.mistral.ai/v1'],
    ['llama-4-scout', 'https://api.cerebras.ai/v1'],
    ['llama-3.3-70b', 'https://api.groq.com/openai/v1'],
    ['Meta-Llama-3.3-70B', 'https://api.sambanova.ai/v1'],
    ['gpt-5.6-sol', undefined],
    // Substring tricks are not a host match.
    ['m', 'https://moonshot.ai.evil.example/v1'],
    ['m', 'https://evil.example/moonshot.ai/v1'],
  ] as const)('%s @ %s → strict side', (model, baseURL) => {
    expect(reasoningEchoFamily(model, baseURL)).toBeUndefined()
  })
})

describe('§11.9-① E — a strict endpoint gets no reasoning_content', () => {
  const history = [
    user('q'),
    assistant('m1', [
      { type: 'thinking', thinking: 'deepseek reasoning', signature: '' },
      { type: 'text', text: 'ok' },
    ]),
    user('follow up'),
  ]

  test('before the policy: the converter still emits it (pinned baseline)', () => {
    const converted = anthropicMessagesToOpenAI(history, [] as never, {
      enableThinking: false,
    })
    expect(converted[1] as unknown).toEqual({
      role: 'assistant',
      content: 'ok',
      reasoning_content: 'deepseek reasoning',
    })
  })

  test.each([
    ['mistral-large-latest', 'https://api.mistral.ai/v1'],
    ['llama-4-scout', 'https://api.cerebras.ai/v1'],
    ['llama-3.3-70b', 'https://api.groq.com/openai/v1'],
    ['Meta-Llama-3.3-70B', 'https://api.sambanova.ai/v1'],
  ] as const)('on the wire to %s @ %s: stripped', (model, baseURL) => {
    const [turn] = bodyFor({ model, baseURL, history, enableThinking: false })
    expect(turn).toEqual({ role: 'assistant', content: 'ok' })
  })
})

describe('§11.9-① F — a Kimi tool turn carries reasoning_content', () => {
  const history = [
    user('q'),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    {
      type: 'user',
      uuid: 'u-tr',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    } as unknown as UserMessage,
  ]

  test('kimi-k3 @ api.moonshot.cn: single-space pad', () => {
    const [turn] = bodyFor({
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.cn/v1',
      history,
      enableThinking: false,
    })
    expect(turn?.reasoning_content).toBe(' ')
    expect(turn?.tool_calls).toEqual([
      {
        id: 't1',
        type: 'function',
        function: { name: 'Read', arguments: '{}' },
      },
    ])
  })

  test('kimi-k3 behind an aggregator: no key (hermes: host-driven)', () => {
    const [turn] = bodyFor({
      model: 'kimi-k3',
      baseURL: 'https://gateway.example/v1',
      history,
      enableThinking: false,
    })
    expect('reasoning_content' in (turn ?? {})).toBe(false)
  })
})

describe('applyReasoningReplayPolicy — per family', () => {
  const converted: ChatCompletionMessageParam[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'a1',
      reasoning_content: 'chain',
    } as ChatCompletionMessageParam,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ],
      reasoning_content: '',
    } as ChatCompletionMessageParam,
    { role: 'tool', tool_call_id: 't1', content: 'ok' },
    { role: 'assistant', content: 'a2' },
    {
      role: 'assistant',
      content: 'a3',
      reasoning_content: null,
    } as unknown as ChatCompletionMessageParam,
  ]
  const reasoningOf = (messages: ChatCompletionMessageParam[]) =>
    messages
      .filter(m => m.role === 'assistant')
      .map(m =>
        'reasoning_content' in m
          ? (m as { reasoning_content: unknown }).reasoning_content
          : 'ABSENT',
      )

  test('kimi / mimo: keep, "" → " ", missing or non-string → " "', () => {
    for (const target of [
      { model: 'kimi-k3', baseURL: 'https://api.kimi.com/coding/v1' },
      { model: 'mimo-v2.6-pro', baseURL: 'https://api.xiaomimimo.com/v1' },
    ]) {
      expect(
        reasoningOf(applyReasoningReplayPolicy(converted, target)),
      ).toEqual(['chain', ' ', ' ', ' '])
    }
  })

  test('deepseek: Qianmo contract unchanged, same objects', () => {
    const out = applyReasoningReplayPolicy(converted, {
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
    })
    expect(out).toEqual(converted)
    out.forEach((message, i) => expect(message).toBe(converted[i]!))
  })

  test('strict side: the key is removed, even "" and null', () => {
    expect(
      reasoningOf(
        applyReasoningReplayPolicy(converted, {
          model: 'mistral-large-latest',
          baseURL: 'https://api.mistral.ai/v1',
        }),
      ),
    ).toEqual(['ABSENT', 'ABSENT', 'ABSENT', 'ABSENT'])
  })

  test('pure: the input is not mutated', () => {
    const snapshot = JSON.stringify(converted)
    applyReasoningReplayPolicy(converted, {
      model: 'kimi-k3',
      baseURL: 'https://api.moonshot.ai/v1',
    })
    applyReasoningReplayPolicy(converted, {
      model: 'm',
      baseURL: 'https://api.groq.com/openai/v1',
    })
    expect(JSON.stringify(converted)).toBe(snapshot)
  })
})
