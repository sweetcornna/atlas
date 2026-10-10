// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compileProfile } from '../../src/providers/compile.js'
import {
  withoutModelConfigEnvironment,
  withoutManagedConfigEnvironment,
  inheritedProviderKeyNames,
} from '../../src/providers/whitelist.js'
import { withoutProviderKeys } from '../../src/host/residentOmpEnv.js'
import { probeCall } from '../../src/commands/providerCall.js'
import { wireProfile } from './helpers.js'
import { isolatedRoot } from './fake.js'
import { providerRuntime } from '../../../../tests/integration/fixtures/provider-runtime.js'
const CAPS = {
  protocol: 1 as const,
  multiKey: true,
  replayFilter: true,
  chatEffortHonorsOverride: true,
}
const KEY_ALIAS = 'AWS_SECRET_ACCESS_KEY'
const HEADER_ALIAS = 'AWS_SESSION_TOKEN'
const KEY_CANARY = 'synthetic-ambient-key-do-not-send'
const HEADER_CANARY = 'synthetic-ambient-header-do-not-send'

test('provider environment scrub treats variable names case insensitively and retains unrelated values', () => {
  const env = {
    openai_api_key: 'synthetic-openai',
    Anthropic_Auth_Token: 'synthetic-anthropic',
    Claude_Code_Model: 'synthetic-model',
    NORMAL: 'retained',
  }
  expect(inheritedProviderKeyNames(env)).toEqual([
    'Anthropic_Auth_Token',
    'Claude_Code_Model',
    'openai_api_key',
  ])
  expect(withoutProviderKeys(env)).toEqual({ NORMAL: 'retained' })
  expect(env.openai_api_key).toBe('synthetic-openai')
})

test('real call probe treats both credential and workspace header as literals, never inherited-variable references', async () => {
  const f = isolatedRoot()
  const seen: Headers[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      if (req.method === 'POST') seen.push(req.headers)
      return Response.json(
        { error: { message: 'test-only' } },
        { status: req.method === 'POST' ? 401 : 200 },
      )
    },
  })
  try {
    const p = wireProfile({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { scheme: 'x-api-key', keys: [{ id: 'a', value: KEY_ALIAS }] },
      compat: { 'headers.anthropic-workspace-id': HEADER_ALIAS },
    })
    const r = compileProfile(p, { secret: KEY_ALIAS, capabilities: CAPS })
    if (!r.ok) throw new Error(r.error.message)
    const result = await probeCall({
      requestId: 'literal',
      baseUrl: p.baseUrl,
      compiled: r.compiled,
      timeoutMs: 10000,
      env: {
        ...process.env,
        [KEY_ALIAS]: KEY_CANARY,
        [HEADER_ALIAS]: HEADER_CANARY,
      },
    })
    expect(result.reachable).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.get('x-api-key')).toBe(KEY_ALIAS)
    expect(seen[0]!.get('anthropic-workspace-id')).toBe(HEADER_ALIAS)
    expect(JSON.stringify([...seen[0]!.entries()])).not.toContain(KEY_CANARY)
    expect(JSON.stringify([...seen[0]!.entries()])).not.toContain(HEADER_CANARY)
    const cleaned = withoutModelConfigEnvironment(
      { aws_secret_access_key: KEY_CANARY, Path: '/safe' },
      r.compiled.models,
    )
    expect(cleaned.aws_secret_access_key).toBeUndefined()
    expect(cleaned.Path).toBe('/safe')
  } finally {
    server.stop(true)
    f.dispose()
  }
}, 15000)
test('real resident ignores an ambient value whose name is a configured API-key literal', async () => {
  const previous = process.env[KEY_ALIAS]
  process.env[KEY_ALIAS] = KEY_CANARY
  const f = await providerRuntime(undefined, {
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: KEY_ALIAS }] },
  })
  try {
    const pool = f.pool()
    const id = await pool.newSession({ agent: 'reviewer', cwd: f.workspace })
    expect((await f.turn(pool, id, 'Literal credential')).result.outcome).toBe(
      'completed',
    )
    expect(f.requests[0]?.headers.get('authorization')).toBe(
      `Bearer ${KEY_ALIAS}`,
    )
  } finally {
    await f.dispose()
    if (previous === undefined) delete process.env[KEY_ALIAS]
    else process.env[KEY_ALIAS] = previous
  }
}, 20000)
test('compiled agent entry removes aliased ambient secrets from its current process environment', async () => {
  const f = await providerRuntime(undefined, {
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: KEY_ALIAS }] },
  })
  const binary = process.env.QIANMO_TEST_COMPILED_QM
  const proc = Bun.spawn(
    [
      ...(binary
        ? [binary]
        : [
            process.execPath,
            resolve(import.meta.dir, '../../src/bin/compiled.ts'),
          ]),
      'agent',
      '-p',
      '--mode',
      'json',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-title',
      'Check literal credentials',
    ],
    {
      cwd: f.workspace,
      env: {
        ...process.env,
        PI_COMPILED: 'true',
        [KEY_ALIAS]: KEY_CANARY,
        [HEADER_ALIAS]: HEADER_CANARY,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 15000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toContain('"type":"message_end"')
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.headers.get('authorization')).toBe(
      `Bearer ${KEY_ALIAS}`,
    )
    expect(JSON.stringify([...f.requests[0]!.headers.entries()])).not.toContain(
      KEY_CANARY,
    )
    expect(JSON.stringify([...f.requests[0]!.headers.entries()])).not.toContain(
      HEADER_CANARY,
    )
  } finally {
    clearTimeout(timeout)
    proc.kill('SIGKILL')
    await proc.exited
    await f.dispose()
  }
}, 20000)
test('standalone environment wrapper follows the target child root, and reserved runtime variable aliases are rejected', () => {
  const f = isolatedRoot()
  try {
    const other = join(f.root, 'other')
    mkdirSync(join(other, 'omp', 'agent'), { recursive: true })
    writeFileSync(
      join(other, 'omp', 'agent', 'models.yml'),
      JSON.stringify({ providers: { 'qm-other': { apiKey: KEY_ALIAS } } }),
    )
    expect(
      withoutManagedConfigEnvironment({
        QIANMO_CONFIG_DIR: other,
        [KEY_ALIAS]: KEY_CANARY,
      })[KEY_ALIAS],
    ).toBeUndefined()
    expect(
      readFileSync(join(other, 'omp', 'agent', 'models.yml'), 'utf8'),
    ).toContain(KEY_ALIAS)
    for (const value of [
      'PATH',
      'home',
      'PI_CONFIG_DIR',
      'QIANMO_EXTENSION_CONFIG',
      'NODE_OPTIONS',
    ]) {
      expect(
        compileProfile(wireProfile(), { secret: value, capabilities: CAPS }).ok,
      ).toBe(false)
      const p = wireProfile({
        compat: { 'headers.anthropic-workspace-id': value },
      })
      expect(
        compileProfile(p, { secret: 'literal-not-env', capabilities: CAPS }).ok,
      ).toBe(false)
    }
  } finally {
    f.dispose()
  }
})
