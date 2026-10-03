// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #13: the Grok lane's effort allowlist and clamp.
 *
 * Constructed inputs; no vendor is called. Rows from hermes
 * `agent/model_metadata.py:582-632` and `agent/transports/codex.py:439-451`
 * at `f9b29c49b6`. The base suite `src/services/api/grok/__tests__/
 * reasoning.test.ts` pins the unchanged grok-3-mini ladder.
 *
 * Every input of the opt-in gate (`modelSupportsEffort`) is pinned to a Grok
 * session: provider from env with settings mocked empty, no capability pins,
 * no DeepSeek or OpenCode routing. Unpinned, the provider came from the
 * developer's own settings (`modelType: openai` passed); on a runner with no
 * settings it is `firstParty`, whose default for an unknown id is "supports
 * effort", and the default-off rows failed (PR #169 CI, `src/services` shard).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import { resolveGrokReasoningEffort } from 'src/services/api/grok/reasoning.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'
import { grokAcceptsReasoningEffort } from '../effortVendors.js'

const settingsMock = setupSettingsMock()

const TIERS = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'] as const
/** Everything `modelSupportsEffort` reads from the environment. */
const ENV_KEYS = [
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_MODEL',
  ...['GROK', 'ANTHROPIC'].flatMap(prefix =>
    TIERS.flatMap(tier => [
      `${prefix}_DEFAULT_${tier}_MODEL`,
      `${prefix}_DEFAULT_${tier}_MODEL_SUPPORTED_CAPABILITIES`,
    ]),
  ),
]
const savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]))

/** A Grok session with nothing else configured. */
function pinGrokSession(): void {
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_USE_GROK = '1'
}

beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
beforeEach(pinGrokSession)
afterEach(pinGrokSession)
afterAll(() => {
  settingsMock.reset()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('the gate is evaluated for a Grok session', () => {
  expect(getAPIProvider()).toBe('grok')
})

const NEW_ROWS = [
  'grok-4.20-multi-agent-0309',
  'grok-4.3',
  'grok-4.5',
  'grok-4.6',
  'x-ai/grok-4.3',
] as const

describe('default: unchanged until a real-endpoint check (design §5.10)', () => {
  test('grok-3-mini keeps its two-rung ladder', () => {
    expect(resolveGrokReasoningEffort('x-ai/grok-3-mini', 'medium')).toBe(
      'high',
    )
    expect(resolveGrokReasoningEffort('grok-3-mini-fast', 'low')).toBe('low')
  })

  test.each([...NEW_ROWS])('%s sends nothing without an opt-in', model => {
    expect(resolveGrokReasoningEffort(model, 'high')).toBeUndefined()
    // Display agrees with the wire: the control stays off too.
    expect(modelSupportsEffort(model)).toBe(false)
  })
})

describe('explicit opt-in: hermes allowlist and clamp', () => {
  test('grok-4.20-multi-agent / 4.3 / 4.5: low…high pass, above clamps to high', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    for (const model of [
      'grok-4.20-multi-agent-0309',
      'grok-4.3',
      'grok-4.5',
    ]) {
      expect(
        ['low', 'medium', 'high', 'xhigh', 'max'].map(level =>
          resolveGrokReasoningEffort(model, level),
        ),
      ).toEqual(['low', 'medium', 'high', 'high', 'high'])
    }
  })

  test('grok-4.6 tops out at xhigh', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    expect(
      ['low', 'medium', 'high', 'xhigh', 'max'].map(level =>
        resolveGrokReasoningEffort('grok-4.6-fast', level),
      ),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'xhigh'])
  })

  test('models that reject the field stay off even when opted in', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    for (const model of [
      'grok-4',
      'grok-4-0709',
      'grok-4.20-0309-reasoning',
      'grok-4-1-fast-reasoning',
      'grok-code-fast-1',
    ]) {
      expect({ model, sends: grokAcceptsReasoningEffort(model) }).toEqual({
        model,
        sends: false,
      })
      expect(resolveGrokReasoningEffort(model, 'high')).toBeUndefined()
    }
  })

  test('no level chosen, or an ant-only number: nothing', () => {
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    expect(resolveGrokReasoningEffort('grok-4.3', undefined)).toBeUndefined()
    expect(resolveGrokReasoningEffort('grok-4.3', 80)).toBeUndefined()
  })
})
