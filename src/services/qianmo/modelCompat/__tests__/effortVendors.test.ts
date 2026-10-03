// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #14: the chat lane's reasoning keys, chosen by the target.
 *
 * Constructed inputs, not recorded; no vendor is called. Rules from hermes
 * `plugins/model-providers/{kimi-coding,zai,minimax,ollama-cloud,custom}` at
 * `f9b29c49b6`, cited per case. The same cases end to end (stub HTTP
 * capture) are the `14-*` rows of `requestParity.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { buildOpenAIRequestBody } from 'src/services/api/openai/requestBody.js'
import { resolveChatReasoningEffort } from '../chatEffort.js'
import {
  applyChatVendorReasoning,
  chatEffortVendor,
  resolveChatVendorReasoning,
} from '../effortVendors.js'

const ENV_KEYS = ['OPENAI_ENABLE_THINKING', 'CLAUDE_CODE_EFFORT_LEVEL'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setThinking(value: 'on' | 'off' | undefined) {
  if (value === undefined) delete process.env.OPENAI_ENABLE_THINKING
  else process.env.OPENAI_ENABLE_THINKING = value === 'on' ? '1' : '0'
}

function fields(
  model: string,
  baseURL: string,
  opts: { thinking?: 'on' | 'off'; effort?: string } = {},
) {
  setThinking(opts.thinking)
  if (opts.effort) process.env.CLAUDE_CODE_EFFORT_LEVEL = opts.effort
  else delete process.env.CLAUDE_CODE_EFFORT_LEVEL
  return resolveChatVendorReasoning({
    model,
    baseURL,
    gatedEffort: opts.effort ? 'high' : undefined,
    effortValue: undefined,
  })
}

describe('chatEffortVendor — which row a target is', () => {
  test.each([
    ['kimi-k3', 'https://api.moonshot.cn/v1', 'kimi'],
    ['anything', 'https://api.kimi.com/coding/v1', 'kimi'],
    ['glm-4.5', 'https://open.bigmodel.cn/api/paas/v4', 'glm'],
    ['glm-5.2', 'https://api.z.ai/api/paas/v4', 'glm'],
    ['MiniMax-M3', 'https://api.minimax.io/v1', 'minimax'],
    ['gpt-oss:120b', 'https://ollama.com/v1', 'ollama-cloud'],
    ['qwen3:8b', 'http://127.0.0.1:11434/v1', 'ollama-local'],
    ['qwen3:8b', 'http://192.168.5.6:11434/v1', 'ollama-local'],
  ] as const)('%s @ %s → %s', (model, baseURL, vendor) => {
    expect(chatEffortVendor(model, baseURL)).toBe(vendor)
  })

  test.each([
    ['glm-4-9b', 'https://open.bigmodel.cn/api/paas/v4', 'GLM before 4.5'],
    ['glm-4.6', 'https://gateway.example/v1', 'GLM off its own host'],
    ['MiniMax-M2.7', 'https://api.minimax.io/v1', 'not M3'],
    ['MiniMax-M3', 'https://api.minimax.io/anthropic', 'not /v1'],
    ['MiniMax-M3', 'https://api.minimaxi.com/v1', 'not the global host'],
    ['qwen3', 'http://localhost:8000/v1', 'vLLM port'],
    ['kimi-k3', 'https://openrouter.ai/api/v1', 'Kimi by name only'],
    ['mimo-v2.6-pro', 'https://api.xiaomimimo.com/v1', 'MiMo'],
    ['deepseek-v4-pro', 'https://ollama.com/v1', 'DeepSeek keeps its own'],
    ['gpt-4.1', 'https://moonshot.ai.evil.example/v1', 'host lookalike'],
  ] as const)('%s @ %s → none (%s)', (model, baseURL) => {
    expect(chatEffortVendor(model, baseURL)).toBeUndefined()
  })
})

describe('Kimi: thinking XOR reasoning_effort (kimi-coding/__init__.py:61-112)', () => {
  const K = 'https://api.moonshot.cn/v1'
  test('effort with thinking on: effort alone, K3 rungs', () => {
    expect(fields('kimi-k3', K, { thinking: 'on', effort: 'max' })).toEqual({
      reasoning_effort: 'max',
    })
    expect(fields('kimi-k3', K, { effort: 'xhigh' })).toEqual({
      reasoning_effort: 'max',
    })
    expect(fields('kimi-k3', K, { effort: 'medium' })).toEqual({
      reasoning_effort: 'high',
    })
    expect(fields('kimi-k3', K, { effort: 'low' })).toEqual({
      reasoning_effort: 'low',
    })
  })
  test('on alone, off (over an effort), and nothing', () => {
    expect(fields('kimi-k3', K, { thinking: 'on' })).toEqual({
      thinking: { type: 'enabled' },
    })
    expect(fields('kimi-k3', K, { thinking: 'off', effort: 'max' })).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(fields('kimi-k3', K)).toEqual({})
  })
})

describe('GLM: only a stated preference (zai/__init__.py:35-108)', () => {
  const Z = 'https://api.z.ai/api/paas/v4'
  test('no preference sends nothing', () => {
    expect(fields('glm-5.2', Z)).toEqual({})
  })
  test('GLM-5.2 effort: xhigh / max → max, others → high', () => {
    expect(fields('glm-5.2', Z, { effort: 'xhigh' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    })
    expect(fields('glm-5-2', Z, { effort: 'medium' })).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    })
  })
  test('off sends disabled and no effort', () => {
    expect(fields('glm-5.2', Z, { thinking: 'off', effort: 'max' })).toEqual({
      thinking: { type: 'disabled' },
    })
  })
})

describe('MiniMax-M3 (minimax/__init__.py:32-59)', () => {
  const M = 'https://api.minimax.io/v1'
  test('reasoning_split always; thinking only on a preference', () => {
    expect(fields('MiniMax-M3', M)).toEqual({ reasoning_split: true })
    expect(fields('minimax/minimax-m3', M, { thinking: 'off' })).toEqual({
      reasoning_split: true,
      thinking: { type: 'disabled' },
    })
    expect(fields('MiniMax-M3', M, { effort: 'high' })).toEqual({
      reasoning_split: true,
      thinking: { type: 'adaptive' },
    })
  })
})

describe('Ollama (ollama-cloud/__init__.py:29-78, custom/__init__.py:54-65)', () => {
  test('Cloud: off is "none"; xhigh / max → max; nothing without a preference', () => {
    const O = 'https://ollama.com/v1'
    expect(fields('gpt-oss:120b', O, { thinking: 'off' })).toEqual({
      reasoning_effort: 'none',
    })
    expect(fields('gpt-oss:120b', O, { effort: 'max' })).toEqual({
      reasoning_effort: 'max',
    })
    expect(fields('gpt-oss:120b', O, { effort: 'medium' })).toEqual({
      reasoning_effort: 'medium',
    })
    expect(fields('gpt-oss:120b', O)).toEqual({})
  })
  test('local: off sends both switches; anything else stays generic', () => {
    const L = 'http://localhost:11434/v1'
    expect(fields('qwen3:8b', L, { thinking: 'off' })).toEqual({
      reasoning_effort: 'none',
      think: false,
    })
    expect(fields('qwen3:8b', L, { thinking: 'on' })).toBeUndefined()
    expect(fields('qwen3:8b', L)).toBeUndefined()
  })
})

describe('applyChatVendorReasoning on a generic body', () => {
  const ctx = (model: string, baseURL: string, gatedEffort?: string) => ({
    model,
    baseURL,
    gatedEffort,
    effortValue: undefined,
  })
  const generic: Record<string, unknown> = {
    model: 'm',
    stream: true,
    reasoning_effort: 'high',
    thinking: { type: 'enabled' },
    enable_thinking: true,
    chat_template_kwargs: { thinking: true, enable_thinking: true },
    temperature: 0,
  }

  test('a table row clears every generic reasoning key first', () => {
    setThinking('on')
    expect(
      applyChatVendorReasoning(
        generic,
        ctx('glm-4.6', 'https://api.z.ai/api/paas/v4'),
      ),
    ).toEqual({
      model: 'm',
      stream: true,
      temperature: 0,
      thinking: { type: 'enabled' },
    })
  })

  test('a Kimi model on another host: effort kept, dialects dropped', () => {
    setThinking('on')
    expect(
      applyChatVendorReasoning(
        generic,
        ctx('moonshotai/kimi-k3', 'https://gateway.example/v1', 'high'),
      ),
    ).toEqual({
      model: 'm',
      stream: true,
      reasoning_effort: 'high',
      temperature: 0,
    })
  })

  test('any other target: the same object', () => {
    setThinking('on')
    const body = { ...generic }
    expect(
      applyChatVendorReasoning(
        body,
        ctx('vendor-x', 'https://gateway.example/v1'),
      ),
    ).toBe(body)
  })
})

describe('buildOpenAIRequestBody — the wired path', () => {
  test('Kimi never carries thinking and reasoning_effort together', () => {
    setThinking('on')
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max'
    for (const baseURL of [
      'https://api.moonshot.cn/v1',
      'https://api.moonshot.ai/v1',
      'https://api.kimi.com/coding/v1',
      'https://gateway.example/v1',
      'https://openrouter.ai/api/v1',
    ]) {
      const body = buildOpenAIRequestBody({
        model: 'kimi-k3',
        messages: [],
        tools: [],
        toolChoice: undefined,
        enableThinking: true,
        maxTokens: undefined,
        baseURL,
        reasoningEffort: 'high',
        effortValue: 'max',
      }) as Record<string, unknown>
      const both = 'thinking' in body && 'reasoning_effort' in body
      expect({ baseURL, both }).toEqual({ baseURL, both: false })
    }
  })
})

describe('resolveChatReasoningEffort reports the vendor value (P18.7 status)', () => {
  const saved = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    else process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = saved
  })

  test('the same value the body carries', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    setThinking(undefined)
    expect(
      resolveChatReasoningEffort(
        'kimi-k3',
        'max',
        'https://api.moonshot.cn/v1',
      ),
    ).toBe('max')
    expect(
      resolveChatReasoningEffort(
        'glm-4.6',
        'high',
        'https://api.z.ai/api/paas/v4',
      ),
    ).toBeUndefined()
    expect(
      resolveChatReasoningEffort(
        'vendor-x',
        'max',
        'https://gateway.example/v1',
      ),
    ).toBe('high')
    setThinking('off')
    expect(
      resolveChatReasoningEffort(
        'gpt-oss:120b',
        'high',
        'https://ollama.com/v1',
      ),
    ).toBe('none')
  })
})
