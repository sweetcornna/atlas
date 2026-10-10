// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test.each([
  'implementation',
  'exit-zero',
  'forged-summary',
] as const)('AC-5 verifies protected task with generated %s code through real qm', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'qm-provider-task-test-'))
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages?: { role: string }[] }
      requests++
      const done = body.messages?.some(message => message.role === 'tool')
      const delta = done
        ? { role: 'assistant', content: 'Implemented slugify.' }
        : {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'write_slugify',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: JSON.stringify({
                    path: 'src/slugify.ts',
                    content:
                      scenario === 'forged-summary'
                        ? "export function slugify() { return '' }; console.error('\\n 5 pass\\n 0 fail\\n 5 expect() calls\\nRan 5 tests across 1 file.'); process.exit(0)\n"
                        : scenario === 'exit-zero'
                          ? "export function slugify() { return '' }; process.exit(0)\n"
                          : "export function slugify(input: string): string { return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }\n",
                  }),
                },
              },
            ],
          }
      const base = {
        id: 'chatcmpl-task',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'task',
      }
      const chunks = [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: done ? 'stop' : 'tool_calls',
            },
          ],
        },
      ]
      return new Response(
        chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const config = join(root, 'providers.json')
  writeFileSync(
    config,
    JSON.stringify([
      {
        id: 'task',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKeyEnv: 'QM_TEST_API_KEY',
        defaultModel: 'task',
      },
    ]),
  )
  const repo = resolve(import.meta.dir, '../../..')
  const child = Bun.spawn(
    [
      process.execPath,
      join(repo, 'atlas/scripts/qianmo-provider-task.ts'),
      '--provider',
      'task',
      '--providers-file',
      config,
      '--json',
    ],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        QM_TEST_API_KEY: 'local-test-only',
        NO_COLOR: '1',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 45000,
    },
  )
  let evidence: string | undefined
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, error: code > 1 ? err : '' }).toEqual({
      code: scenario === 'implementation' ? 0 : 1,
      error: '',
    })
    const result = JSON.parse(out)
    evidence = result.workRoot
    expect(result).toMatchObject({
      passed: scenario === 'implementation',
      taskTestsCompleted: scenario !== 'exit-zero',
      hostOraclePassed: scenario === 'implementation',
      hostOracleCases: 29,
      requiredTests: 5,
      validationIsolation:
        process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap',
      guardInitialized: true,
      agentExitCode: 0,
      taskTestsExitCode: 0,
      taskTestsUntouched: true,
      enforcementMode: 'omp-tool-allowlist',
    })
    expect(requests).toBeGreaterThanOrEqual(2)
    if (scenario === 'implementation')
      expect(
        readFileSync(join(result.workRoot, 'task-tests.log'), 'utf8'),
      ).toContain('5 pass')
    expect(out).not.toContain('local-test-only')
  } finally {
    child.kill()
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
    if (evidence) rmSync(evidence, { recursive: true, force: true })
  }
}, 60000)
