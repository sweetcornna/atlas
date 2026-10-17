// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { buildEditionArg } from '../build-qm.ts'

describe('build-qm --edition', () => {
  test('without the flag builds the default edition', () => {
    expect(buildEditionArg([])).toBe('default')
  })

  test('--edition public builds the public edition', () => {
    expect(buildEditionArg(['--edition', 'public'])).toBe('public')
  })

  test('an unknown or missing value is refused', () => {
    expect(() => buildEditionArg(['--edition', 'pro'])).toThrow(
      '--edition must be default or public',
    )
    expect(() => buildEditionArg(['--edition'])).toThrow(
      '--edition must be default or public',
    )
  })
})
