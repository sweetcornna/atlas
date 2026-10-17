// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm mcp-exec` (P32 audit 9): an operator's MCP server for qianmopi starts
 * with the baseline environment and its own variables, never the node's.
 */

import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { mcpExecPlan } from '../../src/commands/mcpExec.js'

const NODE_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  QIANMO_TRANSPORT_PSK_BETA: 'transport-key',
  ANTHROPIC_API_KEY: 'model-key',
  QIANMO_CONFIG_DIR: '/srv/qianmo',
  DOCS_TOKEN: 'server-secret',
}

test('keeps the baseline and the named variables, nothing else', () => {
  expect(
    mcpExecPlan(
      ['--keep', 'DOCS_TOKEN', '--', 'docs-mcp', '--stdio'],
      NODE_ENV,
    ),
  ).toEqual({
    command: 'docs-mcp',
    args: ['--stdio'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/home/node',
      LANG: 'C.UTF-8',
      DOCS_TOKEN: 'server-secret',
    },
  })
  expect(mcpExecPlan(['--', 'docs-mcp'], NODE_ENV)).toEqual({
    command: 'docs-mcp',
    args: [],
    env: { PATH: '/usr/bin:/bin', HOME: '/home/node', LANG: 'C.UTF-8' },
  })
})

test('refuses what it cannot read', () => {
  expect(mcpExecPlan(['docs-mcp'], NODE_ENV)).toBe('unknown argument: docs-mcp')
  expect(mcpExecPlan(['--'], NODE_ENV)).toBe('missing -- <command>')
  expect(mcpExecPlan(['--keep', 'A=B', '--', 'x'], NODE_ENV)).toBe(
    '--keep takes variable names',
  )
})

test('the server runs in place of the wrapper, with that environment', async () => {
  const cli = join(import.meta.dir, '..', '..', 'src', 'cli.ts')
  const child = Bun.spawn(
    [process.execPath, cli, 'mcp-exec', '--keep', 'DOCS_TOKEN', '--', 'env'],
    { env: { ...NODE_ENV, PATH: process.env.PATH ?? '' }, stdout: 'pipe' },
  )
  const out = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const names = out
    .trim()
    .split('\n')
    .map(line => line.split('=')[0])
  expect(names).toContain('DOCS_TOKEN')
  expect(names).not.toContain('QIANMO_TRANSPORT_PSK_BETA')
  expect(names).not.toContain('ANTHROPIC_API_KEY')
  expect(names).not.toContain('QIANMO_CONFIG_DIR')
  const missing = Bun.spawn(
    [process.execPath, cli, 'mcp-exec', '--', 'no-such-mcp-cmd'],
    { env: { PATH: '/usr/bin:/bin' }, stderr: 'pipe' },
  )
  expect(await missing.exited).toBe(127)
  expect(await new Response(missing.stderr).text()).toContain(
    'Executable not found in $PATH: "no-such-mcp-cmd"',
  )
})

/**
 * `qm mcp-exec` in a process whose `execve` exists but fails, as it can for a
 * compiled binary on some Linux hosts.
 */
function withFailingExecve(argv: string[], env: Record<string, string>) {
  const cli = join(import.meta.dir, '..', '..', 'src', 'cli.ts')
  return Bun.spawn(
    [
      process.execPath,
      '-e',
      [
        "process.execve = () => { throw new Error('execve failed') }",
        `const { main } = await import(${JSON.stringify(cli)})`,
        `process.exitCode = await main(${JSON.stringify(['mcp-exec', ...argv])})`,
      ].join('\n'),
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  )
}

test('where execve fails, the server runs as a child with that environment and its exit code is passed on', async () => {
  const child = withFailingExecve(
    ['--keep', 'DOCS_TOKEN', '--', '/bin/sh', '-c', 'env; exit 7'],
    { ...NODE_ENV, PATH: process.env.PATH ?? '' },
  )
  const out = await new Response(child.stdout).text()
  expect(await child.exited).toBe(7)
  const names = out
    .trim()
    .split('\n')
    .map(line => line.split('=')[0])
  expect(names).toContain('DOCS_TOKEN')
  expect(names).not.toContain('QIANMO_TRANSPORT_PSK_BETA')
  expect(names).not.toContain('ANTHROPIC_API_KEY')
  expect(names).not.toContain('QIANMO_CONFIG_DIR')
})

test('where execve fails, a termination signal reaches the server', async () => {
  const child = withFailingExecve(
    [
      '--',
      '/bin/sh',
      '-c',
      'trap "exit 42" TERM; echo ready; while :; do sleep 0.05; done',
    ],
    { PATH: '/usr/bin:/bin' },
  )
  const reader = child.stdout.getReader()
  let seen = ''
  while (!seen.includes('ready')) {
    const { value, done } = await reader.read()
    if (done) break
    seen += new TextDecoder().decode(value)
  }
  expect(seen).toContain('ready')
  child.kill('SIGTERM')
  expect(await child.exited).toBe(42)
})
