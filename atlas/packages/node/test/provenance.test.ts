// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import pkg from '../package.json' with { type: 'json' }
import {
  buildEdition,
  buildTime,
  buildVersion,
  ompVersion,
  publicSourceUrl,
  publishedSourceCommit,
  sourceCommit,
  sourceTreeUrl,
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

describe('buildEdition', () => {
  const savedEdition = process.env.QIANMO_EDITION

  afterEach(() => {
    if (savedEdition === undefined) delete process.env.QIANMO_EDITION
    else process.env.QIANMO_EDITION = savedEdition
  })

  test('a source run is the default edition', () => {
    delete process.env.QIANMO_EDITION

    expect(buildEdition()).toBe('default')
  })

  test('QIANMO_EDITION=public opts a source run into the public edition', () => {
    process.env.QIANMO_EDITION = 'public'

    expect(buildEdition()).toBe('public')
  })

  test('any other QIANMO_EDITION value stays default', () => {
    process.env.QIANMO_EDITION = 'PUBLIC'

    expect(buildEdition()).toBe('default')
  })
})

/**
 * The public edition names its corresponding source (AGPL §13) as the
 * repository at the commit this qm runs; a build that cannot name one clean
 * commit has nothing honest to link (public-edition.md §0).
 */
describe('the public source link', () => {
  const SHA = 'd'.repeat(40)

  test('a stamped or declared full SHA is published as it is', () => {
    process.env.QIANMO_SOURCE_COMMIT = SHA

    expect(publishedSourceCommit()).toBe(SHA)
  })

  test('a -dirty or unknown build publishes nothing', () => {
    process.env.QIANMO_SOURCE_COMMIT = `${SHA}-dirty`
    expect(publishedSourceCommit()).toBeNull()

    process.env.QIANMO_SOURCE_COMMIT = 'unknown'
    expect(publishedSourceCommit()).toBeNull()
  })

  test('a source run counts only while its tracked files are unchanged', () => {
    delete process.env.QIANMO_SOURCE_COMMIT
    const status = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      { cwd: import.meta.dir, encoding: 'utf8' },
    )
    const clean = status.status === 0 && status.stdout.trim() === ''
    const head = sourceCommit()

    expect(publishedSourceCommit()).toBe(
      clean && /^[0-9a-f]{40}$/.test(head) ? head : null,
    )
  })

  test('the link is the repository at that commit', () => {
    expect(sourceTreeUrl('https://github.com/sweetcornna/atlas', SHA)).toBe(
      `https://github.com/sweetcornna/atlas/tree/${SHA}`,
    )
    expect(sourceTreeUrl('https://github.com/sweetcornna/atlas/', SHA)).toBe(
      `https://github.com/sweetcornna/atlas/tree/${SHA}`,
    )
    expect(sourceTreeUrl('https://git.example.cn', SHA)).toBe(
      `https://git.example.cn/tree/${SHA}`,
    )
  })

  test('a repository address with a query or fragment, or a commit that is not a full SHA, is refused', () => {
    expect(() =>
      sourceTreeUrl('https://github.com/sweetcornna/atlas?tab=readme', SHA),
    ).toThrow('no query or fragment')
    expect(() =>
      sourceTreeUrl('https://github.com/sweetcornna/atlas#readme', SHA),
    ).toThrow('no query or fragment')
    expect(() =>
      sourceTreeUrl('https://github.com/sweetcornna/atlas', `${SHA}-dirty`),
    ).toThrow('full commit')
  })

  test('publicSourceUrl pins the configured repository to this build, or refuses', () => {
    process.env.QIANMO_SOURCE_COMMIT = SHA
    expect(publicSourceUrl('https://github.com/sweetcornna/atlas')).toBe(
      `https://github.com/sweetcornna/atlas/tree/${SHA}`,
    )

    process.env.QIANMO_SOURCE_COMMIT = `${SHA}-dirty`
    expect(() =>
      publicSourceUrl('https://github.com/sweetcornna/atlas'),
    ).toThrow(`this build is ${SHA}-dirty`)
  })
})
