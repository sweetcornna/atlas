// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Exercise the real CLI diagnostic. Silence is accepted only after a request. */
import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ompChildEnv } from '@qianmo/paths'

let child: ChildProcess | undefined
let server: ReturnType<typeof Bun.serve> | undefined
let root: string | undefined
const prior = process.env.QIANMO_CONFIG_DIR
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>(resolve =>
      child!.once('exit', () => resolve()),
    )
    child.kill('SIGTERM')
    await exited
  }
  await server?.stop(true)
  if (prior === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = prior
  if (root) rmSync(root, { recursive: true, force: true })
  child = undefined
  server = undefined
})
test.each([
  401, 200,
])('qm resident startup probes the configured omp endpoint (%i)', async status => {
  root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-startup-'))
  const workspace = join(root, 'work')
  mkdirSync(workspace)
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  let calls = 0
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      calls++
      await request.text()
      if (status === 401)
        return Response.json(
          { error: { message: 'test credential refused' } },
          { status },
        )
      const base = {
        id: 'probe',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'probe',
      }
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'ok' },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      ]
      return new Response(
        `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  const dir = join(process.env.QIANMO_CONFIG_DIR, 'omp/agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'models.yml'),
    `providers:\n  fake:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    api: openai-completions\n    apiKey: probe-not-secret\n    models:\n      - id: probe\n        contextWindow: 65536\n        maxTokens: 4096\n`,
  )
  writeFileSync(
    join(dir, 'config.yml'),
    'modelRoles:\n  default: fake/probe\ndefaultThinkingLevel: off\nretry:\n  enabled: false\nproviders:\n  cacheWarming: off\n',
  )
  child = spawn(
    process.execPath,
    [
      join(import.meta.dir, '../../packages/node/src/cli.ts'),
      'resident',
      '--node',
      'probe',
      '--team',
      'nest',
      '--agent',
      `reviewer=${workspace}`,
      '--unix',
      join(root, 'node.sock'),
      '--open-policy',
    ],
    {
      env: {
        ...ompChildEnv(process.env),
        QIANMO_TRANSPORT_PSK: 'startup-probe-test-not-secret',
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  let errors = ''
  child.stdout?.on('data', data => {
    output += data.toString()
  })
  child.stderr?.on('data', data => {
    errors += data.toString()
  })
  const deadline = Date.now() + 20_000
  while (
    Date.now() < deadline &&
    (calls === 0 || (status === 401 && !errors.includes('HTTP 401')))
  ) {
    if (child.exitCode !== null)
      throw new Error(`resident exited: ${output}\n${errors}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(calls).toBeGreaterThan(0)
  if (status === 401)
    expect(errors).toContain('REFUSED its credential: HTTP 401')
  else {
    expect(errors).not.toContain('REFUSED')
    expect(errors).not.toContain('could not run')
  }
}, 30_000)
