// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  eligiblePatterns,
  groupEligible,
  ineligiblePatterns,
  type MagpieAccess,
  type MagpieGroup,
  type MagpieProvider,
  NO_MODEL_PATTERN,
  patternsConfined,
} from '../src/index.js'

function provider(
  id: string,
  access: MagpieAccess,
  enabled = true,
): MagpieProvider {
  return {
    id,
    name: id,
    preset: id,
    host: `${id}.example.test`,
    enabled,
    ready: enabled,
    models: 1,
    modelIds: ['m'],
    access,
    plan: null,
  }
}

function group(
  id: string,
  members: string[],
  extra: Partial<MagpieGroup> = {},
): MagpieGroup {
  return {
    id,
    name: id,
    members,
    matched: [],
    match: [],
    routing: 'smart',
    affinity: 'auto',
    classifier: '',
    ready: true,
    ...extra,
  }
}

const PROVIDERS = [
  provider('openai', 'key'),
  provider('deepseek', 'key', false),
  provider('codex', 'account'),
  provider('zen', 'client'),
]

describe('eligiblePatterns', () => {
  test('every API-key provider, on or off, and no other', () => {
    expect(eligiblePatterns(PROVIDERS, [])).toEqual(['openai/*', 'deepseek/*'])
  })

  test('groups only when every member is of an API-key provider', () => {
    const groups = [
      group('fast', ['openai/gpt-6-mini', 'deepseek/v4:high']),
      group('mixed', ['openai/gpt-6', 'codex/gpt-6-codex']),
      group('client', ['zen/big-pickle']),
      group('empty', []),
    ]
    expect(eligiblePatterns(PROVIDERS, groups)).toEqual([
      'openai/*',
      'deepseek/*',
      'group/fast',
    ])
  })

  test('matched members and patterns count', () => {
    const groups = [
      group('matched-account', ['openai/gpt-6'], {
        matched: ['codex/gpt-6-codex'],
      }),
      group('confined', ['openai/gpt-6'], { match: ['openai/*:free'] }),
      group('wide', ['openai/gpt-6'], { match: ['*/gpt-6'] }),
      group('regex', ['openai/gpt-6'], { match: ['re:^openai/'] }),
      group('account-pattern', ['openai/gpt-6'], { match: ['codex/*'] }),
    ]
    expect(eligiblePatterns(PROVIDERS, groups)).toEqual([
      'openai/*',
      'deepseek/*',
      'group/confined',
    ])
  })

  test('nested groups follow their members, and a cycle is not eligible', () => {
    const groups = [
      group('inner', ['openai/gpt-6']),
      group('outer', ['group/inner', 'deepseek/v4']),
      group('bad-inner', ['codex/x']),
      group('bad-outer', ['group/bad-inner']),
      group('loop-a', ['group/loop-b']),
      group('loop-b', ['group/loop-a']),
      group('missing', ['group/nowhere']),
      group('star', ['group/*']),
    ]
    expect(eligiblePatterns(PROVIDERS, groups)).toEqual([
      'openai/*',
      'deepseek/*',
      'group/inner',
      'group/outer',
    ])
  })

  test('a classifier must be eligible too', () => {
    const groups = [
      group('ruled', ['openai/gpt-6'], { classifier: 'codex/fast' }),
      group('ruled-ok', ['openai/gpt-6'], { classifier: 'openai/gpt-6-mini' }),
    ]
    expect(eligiblePatterns(PROVIDERS, groups)).toEqual([
      'openai/*',
      'deepseek/*',
      'group/ruled-ok',
    ])
    expect(groupEligible(groups[0] as MagpieGroup, PROVIDERS, groups)).toBe(
      false,
    )
  })

  test('nothing eligible is one model no provider serves, never an empty list', () => {
    expect(eligiblePatterns([provider('codex', 'account')], [])).toEqual([
      NO_MODEL_PATTERN,
    ])
  })
})

describe('ineligiblePatterns', () => {
  test('names what could reach beyond API-key providers', () => {
    const groups = [
      group('fast', ['openai/gpt-6']),
      group('mixed', ['codex/x', 'openai/y']),
    ]
    expect(
      ineligiblePatterns(
        [
          'openai/gpt-6',
          'openai/*',
          'deepseek/v4',
          'group/fast',
          'group/mixed',
          'group/*',
          'codex/*',
          '*/gpt-6',
          're:x',
          'zen/a',
          'nowhere/a',
          NO_MODEL_PATTERN,
        ],
        PROVIDERS,
        groups,
      ),
    ).toEqual([
      'group/mixed',
      'group/*',
      'codex/*',
      '*/gpt-6',
      're:x',
      'zen/a',
      'nowhere/a',
    ])
  })

  test('patternsConfined wants a non-empty list within what is eligible', () => {
    expect(patternsConfined([], PROVIDERS, [])).toBe(false)
    expect(patternsConfined(['openai/*'], PROVIDERS, [])).toBe(true)
    expect(patternsConfined(['openai/*', 'codex/*'], PROVIDERS, [])).toBe(false)
  })

  test('provider ids compare without case, as magpie does', () => {
    expect(
      ineligiblePatterns(['OpenAI/gpt-6', 'CODEX/x'], PROVIDERS, []),
    ).toEqual(['CODEX/x'])
  })
})
