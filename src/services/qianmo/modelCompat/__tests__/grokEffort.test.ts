// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.8 hermes #13: the Grok lane's effort allowlist and clamp.
 *
 * Constructed inputs; no vendor is called. Rows from hermes
 * `agent/model_metadata.py:582-632` and `agent/transports/codex.py:439-451`
 * at `f9b29c49b6`. The base suite `src/services/api/grok/__tests__/
 * reasoning.test.ts` pins the unchanged grok-3-mini ladder.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveGrokReasoningEffort } from 'src/services/api/grok/reasoning.js'
import { modelSupportsEffort } from 'src/utils/model/effort.js'
import { grokAcceptsReasoningEffort } from '../effortVendors.js'

const saved = process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
  else process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = saved
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
    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    expect(resolveGrokReasoningEffort('x-ai/grok-3-mini', 'medium')).toBe(
      'high',
    )
    expect(resolveGrokReasoningEffort('grok-3-mini-fast', 'low')).toBe('low')
  })

  test.each(NEW_ROWS)('%s sends nothing without an opt-in', model => {
    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
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
