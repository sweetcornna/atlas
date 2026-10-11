// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  assertResidentExtensionBudget,
  RESIDENT_EXTENSION_MAX_BYTES,
} from '../residentExtensionBudget.js'
import { residentExtensionSource } from '../residentExtensionBundle.js'

test('the emitted resident extension stays within the cold-load budget', async () => {
  assertResidentExtensionBudget(await residentExtensionSource())
})

test('the budget rejects UTF-8 byte overflow even below the character limit', () => {
  const artifact = 'é'.repeat(RESIDENT_EXTENSION_MAX_BYTES / 2 + 1)
  expect(artifact.length).toBeLessThan(RESIDENT_EXTENSION_MAX_BYTES)
  expect(() => assertResidentExtensionBudget(artifact)).toThrow(
    `Resident extension is ${RESIDENT_EXTENSION_MAX_BYTES + 2} bytes`,
  )
})

test('a small virtual registry artifact is rejected even within the byte budget', () => {
  expect(() =>
    assertResidentExtensionBudget(
      'export const loaders = "omp-legacy-pi-modules-build"',
    ),
  ).toThrow('bundled host code: omp-legacy-pi-modules')
})

test('a small embedded host implementation is rejected even within the byte budget', () => {
  expect(() =>
    assertResidentExtensionBudget(
      '// packages/coding-agent/src/main.ts\nexport const host = {}',
    ),
  ).toThrow('bundled host code: packages/coding-agent/src/')
})
