// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `runtime.update` (P31): a Claude Code or Codex version goes into the
 * managed prefix only after it passed the compatibility check in a scratch
 * prefix; one that fails leaves the node on what it had and says why.
 */

import { expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlContext } from '../../src/host/control.js'
import {
  managedRuntimePrefix,
  type RunCommand,
  runtimeControl,
} from '../../src/host/runtimeUpdate.js'

const CTX: ControlContext = { peer: 'hub', actor: 'updates', taskId: 't' }

function fakeNpm(installed: string): {
  run: RunCommand
  prefixes: string[]
} {
  const prefixes: string[] = []
  return {
    prefixes,
    run: async argv => {
      if (argv[1] === 'install') {
        prefixes.push(argv[argv.indexOf('--prefix') + 1]!)
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout: `${installed} (Claude Code)` }
    },
  }
}

test('a version that fails the check is not installed, and the update says why (P32 ruling 3)', async () => {
  const npm = fakeNpm('2.2.0')
  const checked: string[] = []
  const installed: string[] = []
  const control = runtimeControl({
    run: npm.run,
    smoke: async (kind, bin) => {
      checked.push(`${kind} ${bin}`)
      return '没有连上 qianmo 工具桥（failed）'
    },
    onInstalled: kind => installed.push(kind),
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'claude-code',
      version: '2.2.0',
    },
    CTX,
  )
  expect(outcome).toEqual({
    ok: false,
    code: 'refused',
    message:
      '2.2.0 没有通过兼容检查，节点继续用原来的版本：没有连上 qianmo 工具桥（failed）',
  })
  // Only the scratch prefix got it, and it is gone again.
  expect(npm.prefixes).toHaveLength(1)
  expect(npm.prefixes[0]).not.toBe(managedRuntimePrefix())
  expect(path.dirname(npm.prefixes[0]!)).toBe(qianmoConfigPath('runtimes'))
  expect(existsSync(npm.prefixes[0]!)).toBe(false)
  expect(checked).toEqual([
    `claude-code ${path.join(npm.prefixes[0]!, 'node_modules', '.bin', 'claude')}`,
  ])
  expect(installed).toEqual([])
  expect(
    readdirSync(qianmoConfigPath('runtimes')).filter(name =>
      name.startsWith('npm-stage-'),
    ),
  ).toEqual([])
})

test('a version that passes goes into the managed prefix', async () => {
  const npm = fakeNpm('0.170.0')
  const installed: string[] = []
  const control = runtimeControl({
    run: npm.run,
    smoke: async () => null,
    onInstalled: kind => installed.push(kind),
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'codex',
      version: '0.170.0',
    },
    CTX,
  )
  expect(outcome).toEqual({
    ok: true,
    value: { runtime: 'codex', version: '0.170.0' },
  })
  expect(npm.prefixes).toHaveLength(2)
  expect(npm.prefixes[1]).toBe(managedRuntimePrefix())
  expect(installed).toEqual(['codex'])
})

test('a scratch install of another version than asked is refused before the check', async () => {
  const npm = fakeNpm('2.1.0')
  let checked = false
  const control = runtimeControl({
    run: npm.run,
    smoke: async () => {
      checked = true
      return null
    },
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'claude-code',
      version: '2.2.0',
    },
    CTX,
  )
  expect(outcome.ok).toBe(false)
  expect(checked).toBe(false)
  expect(npm.prefixes).toHaveLength(1)
})
