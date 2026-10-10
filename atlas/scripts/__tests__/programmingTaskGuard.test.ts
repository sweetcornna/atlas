// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
import {
  taskToolDenial,
  type TaskGuardConfig,
} from '../programmingTaskGuard.js'
const roots: string[] = []
function fixture(): TaskGuardConfig {
  const root = mkdtempSync(join(tmpdir(), 'qm-task-guard-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'allowed.ts'), 'original\n')
  writeFileSync(join(workspace, 'protected.test.ts'), 'protected\n')
  return {
    workspace,
    allowedFiles: ['allowed.ts'],
    readyFile: join(root, 'ready'),
    nonce: crypto.randomUUID(),
  }
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
describe('acceptance tool boundary', () => {
  test('allows only the declared files and denies shell, rename, patch and symlink escapes', () => {
    const config = fixture()
    expect(
      taskToolDenial(config, 'write', { path: 'allowed.ts', content: 'x' }),
    ).toBeUndefined()
    for (const [tool, input] of [
      ['bash', { command: 'true' }],
      ['write', { path: 'protected.test.ts' }],
      ['edit', { path: 'allowed.ts', edits: [{ rename: '../escape.ts' }] }],
      ['edit', { input: '*** Update File: protected.test.ts\n+x' }],
      ['write', { path: '../escape.ts' }],
      ['read', { path: '../secret' }],
    ] as const)
      expect(taskToolDenial(config, tool, input)).toBeString()
    symlinkSync(config.readyFile, join(config.workspace, 'link.ts'))
    expect(taskToolDenial(config, 'write', { path: 'link.ts' })).toBeString()
  })

  test.each([
    'loaded',
    'missing config',
    'missing extension',
  ] as const)('real qm agent fails closed with guard %s', async state => {
    const config = fixture()
    const root = resolve(config.workspace, '..')
    const nodeConfig = join(root, 'config')
    const agentDir = join(nodeConfig, 'omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    const configFile = join(root, 'guard.json')
    writeFileSync(configFile, JSON.stringify(config))
    let requests = 0
    const advertisedTools: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          messages?: { role: string; content?: unknown }[]
          tools?: { function: { name: string } }[]
        }
        requests++
        advertisedTools.push(
          ...(body.tools ?? []).map(tool => tool.function.name),
        )
        const hasTool = body.messages?.some(message => message.role === 'tool')
        const delta = hasTool
          ? { role: 'assistant', content: 'guard probe complete' }
          : {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_write',
                  type: 'function',
                  function: {
                    name: 'write',
                    arguments: JSON.stringify({
                      path: 'protected.test.ts',
                      content: 'tampered\n',
                    }),
                  },
                },
              ],
            }
        const base = {
          id: 'chatcmpl-guard',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'guard',
        }
        const chunks = [
          { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: hasTool ? 'stop' : 'tool_calls',
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
    writeFileSync(
      join(agentDir, 'models.yml'),
      JSON.stringify({
        providers: {
          guard: {
            baseUrl: `http://127.0.0.1:${server.port}/v1`,
            auth: 'none',
            api: 'openai-completions',
            models: [{ id: 'guard', name: 'Guard', reasoning: false }],
          },
        },
      }),
    )
    const repo = resolve(import.meta.dir, '../../..')
    const child = Bun.spawn(
      [
        process.execPath,
        join(repo, 'atlas/packages/node/src/cli.ts'),
        'agent',
        '--print',
        '--mode',
        'json',
        '--model',
        'guard/guard',
        '--no-extensions',
        '--extension',
        state === 'missing extension'
          ? join(root, 'missing.ts')
          : join(repo, 'atlas/scripts/programmingTaskGuard.ts'),
        '--approval-mode',
        'write',
        '--tools',
        '',
        'Try to write protected.test.ts, then finish.',
      ],
      {
        cwd: config.workspace,
        env: ompChildEnv({
          PATH: process.env.PATH,
          HOME: join(root, 'home'),
          QIANMO_CONFIG_DIR: nodeConfig,
          QIANMO_TASK_GUARD_CONFIG:
            state === 'missing config'
              ? join(root, 'missing.json')
              : configFile,
          PI_TEST_RUNTIME: '1',
          NO_COLOR: '1',
        }),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 45000,
      },
    )
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (state === 'loaded') {
        expect({ code, err: code ? err : '' }).toEqual({ code: 0, err: '' })
        expect(requests).toBeGreaterThanOrEqual(2)
        expect(existsSync(config.readyFile)).toBe(true)
        expect(readFileSync(config.readyFile, 'utf8')).toBe(config.nonce)
        expect(out).toContain('outside allowed production files')
      } else {
        expect(existsSync(config.readyFile)).toBe(false)
        expect(advertisedTools).toEqual([])
      }
      expect(
        readFileSync(join(config.workspace, 'protected.test.ts'), 'utf8'),
      ).toBe('protected\n')
    } finally {
      child.kill()
      server.stop(true)
    }
  }, 60000)
})
