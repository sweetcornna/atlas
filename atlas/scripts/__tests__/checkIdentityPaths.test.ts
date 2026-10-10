// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { findBypasses, isScannedPath } from '../check-identity-paths.ts'

const dir = (name: string) => `'.${name}'`

describe('findBypasses', () => {
  test('flags every identity dir literal, in any quote style', () => {
    for (const name of ['qianmo', 'omp', 'claude', 'occ']) {
      expect(findBypasses('a.ts', `const d = ${dir(name)}\n`)).toHaveLength(1)
      expect(findBypasses('a.ts', `const d = ".${name}.json"\n`)).toHaveLength(
        1,
      )
      expect(findBypasses('a.ts', `const d = \`.${name}\`\n`)).toHaveLength(1)
    }
  })

  test('flags homedir()-joined identity paths', () => {
    const hits = findBypasses('a.ts', `join(homedir(), ${dir('omp')}, 'agent')`)
    expect(hits.map(hit => hit.split(' [')[1]?.split(']')[0])).toEqual([
      'identity dir/global-file literal',
      'homedir()-joined identity path',
    ])
  })

  test('ignores comments, third-party dirs and longer names', () => {
    const source = [
      `// keeps ${dir('omp')} out`,
      `/* ${dir('claude')} */`,
      `const codex = '.codex'`,
      `const ca = '.qianmo-ca'`,
      `const url = 'https://x/.omp/y'`,
    ].join('\n')
    expect(findBypasses('a.ts', source)).toEqual([])
  })

  test('reports file and line', () => {
    expect(findBypasses('x/y.ts', `\n\nconst d = ${dir('occ')}`)).toEqual([
      `x/y.ts:3 [identity dir/global-file literal] const d = ${dir('occ')}`,
    ])
  })
})

describe('isScannedPath', () => {
  test('scans atlas and demo production sources only', () => {
    expect(isScannedPath('atlas/packages/node/src/host/resident.ts')).toBe(true)
    expect(isScannedPath('demo/lib/acceptance/runner.ts')).toBe(true)
    expect(isScannedPath('packages/coding-agent/src/cli.ts')).toBe(false)
    expect(isScannedPath('atlas/packages/node/test/x.test.ts')).toBe(false)
    expect(isScannedPath('atlas/scripts/__tests__/x.ts')).toBe(false)
    expect(isScannedPath('atlas/tests/support/credentialEnv.ts')).toBe(false)
    expect(isScannedPath('atlas/packages/node/src/x.d.ts')).toBe(false)
    expect(isScannedPath('demo/env/up.sh')).toBe(false)
  })

  test('the allowlist is exact', () => {
    expect(isScannedPath('atlas/packages/paths/src/index.ts')).toBe(false)
    expect(isScannedPath('atlas/packages/resident/src/guard.ts')).toBe(false)
    expect(isScannedPath('atlas/packages/paths/src/other.ts')).toBe(true)
  })
})
