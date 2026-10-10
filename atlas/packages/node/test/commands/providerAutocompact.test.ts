// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  stageProviderApply,
  commitPendingProviderConfig,
  readProviderState,
  readYaml,
} from '../../src/providers/node.js'
import { providerPaths } from '../../src/providers/store.js'
import { isolatedRoot } from '../providers/fake.js'
import { applyRequest } from '../providers/helpers.js'
import { runQmProvider } from './providerSource.js'
import { AUTO_COMPACT_LIMITS } from '@qianmo/providers'

test('CLI autocompact writes native threshold, reports actual capped trigger, preserves it across provider apply', async () => {
  const f = isolatedRoot()
  const cli = (args: string[], stdin: string | null = null) =>
    runQmProvider({ args, stdin, config: f.root, cwd: f.root })
  try {
    expect(stageProviderApply(applyRequest()).ok).toBe(true)
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    let r = await cli(['autocompact', '150000', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      autoCompactWindow: 150000,
      source: 'settings',
    })
    expect(readYaml(providerPaths.config()).compaction).toMatchObject({
      thresholdTokens: 150000,
      thresholdPercent: -1,
    })
    const before = readFileSync(providerPaths.config(), 'utf8')
    for (const value of [
      'oops',
      String(AUTO_COMPACT_LIMITS.minTokens - 1),
      String(AUTO_COMPACT_LIMITS.maxTokens + 1),
    ]) {
      r = await cli(['autocompact', value, '--json'])
      expect(r.code).toBe(1)
      expect(JSON.parse(r.stdout).code).toBe('bad-value')
      expect(readFileSync(providerPaths.config(), 'utf8')).toBe(before)
    }
    r = await cli(
      ['serve-stdin', '--node', 'beta-1'],
      JSON.stringify({
        v: 1,
        op: 'autocompact',
        node: 'beta-1',
        requestId: '01JAUTOCOMPACT0000000000000',
        value: 170000,
      }) + '\n',
    )
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: true,
      autoCompactWindow: 170000,
    })
    const hash = readProviderState().onDiskHash
    expect(
      stageProviderApply(applyRequest({ expect: { ownedHash: hash } })).ok,
    ).toBe(true)
    expect((await commitPendingProviderConfig()).status).toBe('committed')
    expect(readYaml(providerPaths.config()).compaction).toMatchObject({
      thresholdTokens: 170000,
    })
    r = await cli(['autocompact', 'auto', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).source).toBe('auto')
    expect(readYaml(providerPaths.config()).compaction).toMatchObject({
      thresholdTokens: -1,
      thresholdPercent: -1,
    })
  } finally {
    f.dispose()
  }
}, 60000)
