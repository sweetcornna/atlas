// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ompSpawnEnv } from '../../src/omp/launch.js'
import { residentOmpEnvironment } from '../../src/host/residentOmpEnv.js'

const previous = process.env.QIANMO_CONFIG_DIR
let root: string | undefined
afterEach(() => {
  if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previous
  if (root) rmSync(root, { recursive: true, force: true })
})
test('managed children receive exact isolated omp state and no inherited provider credential', () => {
  root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-env-'))
  process.env.QIANMO_CONFIG_DIR = root
  mkdirSync(join(root, 'qianmo/provider'), { recursive: true })
  writeFileSync(
    join(root, 'qianmo/provider/state.json'),
    JSON.stringify({ v: 2, applied: { requestId: 'applied' } }),
  )
  const env = residentOmpEnvironment({
    ...process.env,
    OPENAI_API_KEY: 'inherited-secret',
    OMP_PROFILE: 'escape',
    PI_CONFIG_FILES: '/escape',
    Pi_Config_Files: '/escape-mixed',
    pi_edit_variant: 'unsafe',
    PI_CODING_AGENT_DIR: '/escape',
  })
  expect(env.OPENAI_API_KEY).toBeUndefined()
  expect(env.OMP_PROFILE).toBeUndefined()
  expect(env.PI_CONFIG_FILES).toBeUndefined()
  expect(env.Pi_Config_Files).toBeUndefined()
  expect(env.pi_edit_variant).toBeUndefined()
  expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
  expect(resolve(homedir(), env.PI_CONFIG_DIR!)).toBe(join(root, 'omp'))
  const probe = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    { env, encoding: 'utf8' },
  )
  expect(probe.status).toBe(0)
  const actual = JSON.parse(probe.stdout)
  expect(actual.PI_CONFIG_DIR).toBe(env.PI_CONFIG_DIR)
  expect(actual.OPENAI_API_KEY).toBeUndefined()
})
test('unmanaged nodes retain their explicitly supplied model credentials', () => {
  root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-env-'))
  process.env.QIANMO_CONFIG_DIR = root
  expect(
    residentOmpEnvironment({ OPENAI_API_KEY: 'operator-key' }).OPENAI_API_KEY,
  ).toBe('operator-key')
})

test('managed literal config values cannot name unrelated inherited secrets, including extra env', () => {
  root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-env-alias-'))
  process.env.QIANMO_CONFIG_DIR = root
  mkdirSync(join(root, 'omp/agent'), { recursive: true })
  writeFileSync(
    join(root, 'omp/agent/models.yml'),
    JSON.stringify({
      providers: {
        'qm-fixture': {
          apiKey: 'AUDIT_API_ALIAS',
          headers: { 'anthropic-workspace-id': 'AUDIT_HEADER_ALIAS' },
        },
      },
    }),
  )
  const aliases = {
    AUDIT_API_ALIAS: 'synthetic-key',
    audit_header_alias: 'synthetic-header',
  }
  for (const env of [
    residentOmpEnvironment({ ...process.env, ...aliases }),
    ompSpawnEnv(aliases),
  ]) {
    expect(env.AUDIT_API_ALIAS).toBeUndefined()
    expect(env.audit_header_alias).toBeUndefined()
    expect(env.QIANMO_CONFIG_DIR).toBe(root)
  }
})
