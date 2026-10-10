// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import pkg from '../package.json' with { type: 'json' }
import {
  buildTime,
  buildVersion,
  ompVersion,
  sourceCommit,
  versionLine,
} from '../src/provenance.js'

/**
 * A source run has no `src/generated/provenance.ts`, so the commit comes from
 * `QIANMO_SOURCE_COMMIT`, then `git rev-parse HEAD`, then `unknown`. The
 * generated file is the compiled build's half, covered by its own smoke test.
 */
const saved = process.env.QIANMO_SOURCE_COMMIT

afterEach(() => {
  if (saved === undefined) delete process.env.QIANMO_SOURCE_COMMIT
  else process.env.QIANMO_SOURCE_COMMIT = saved
})

describe('sourceCommit', () => {
  test('reports QIANMO_SOURCE_COMMIT when set', () => {
    process.env.QIANMO_SOURCE_COMMIT = 'a'.repeat(40)

    expect(sourceCommit()).toBe('a'.repeat(40))
  })

  test('keeps the -dirty suffix intact', () => {
    process.env.QIANMO_SOURCE_COMMIT = `${'b'.repeat(40)}-dirty`

    expect(sourceCommit()).toBe(`${'b'.repeat(40)}-dirty`)
  })

  test('without the env falls back to git HEAD or a non-empty word', () => {
    delete process.env.QIANMO_SOURCE_COMMIT

    expect(sourceCommit()).toMatch(/^([0-9a-f]{40}|unknown)$/)
  })

  test('an empty env value is treated as unset', () => {
    process.env.QIANMO_SOURCE_COMMIT = ''

    expect(sourceCommit()).not.toBe('')
  })
})

describe('buildVersion and ompVersion', () => {
  test('buildVersion is the @qianmo/node package version', () => {
    expect(buildVersion()).toBe(pkg.version)
  })

  test('ompVersion is a semver string', () => {
    expect(ompVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('buildTime', () => {
  test('is undefined in a source run', () => {
    expect(buildTime()).toBeUndefined()
  })
})

describe('versionLine', () => {
  test('has the documented shape', () => {
    process.env.QIANMO_SOURCE_COMMIT = 'c'.repeat(40)

    expect(versionLine()).toBe(
      `qm ${pkg.version} (omp ${ompVersion()}) ${'c'.repeat(40)}`,
    )
  })
})
