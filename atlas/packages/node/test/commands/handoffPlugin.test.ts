// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cliPrefix } from '../../../../tests/integration/fixtures/handoff-processes.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
async function run(tool: string, dryRun = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-plugin-install-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  const log = path.join(root, 'invocations')
  const binary = tool === 'claude-code' ? 'claude' : tool
  fs.writeFileSync(
    path.join(bin, binary),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$P19_LOG"\n',
    { mode: 0o755 },
  )
  const config = path.join(root, 'qianmo')
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    QIANMO_CONFIG_DIR: config,
    PATH: bin,
    P19_LOG: log,
  }
  const exec = async (args: string[]) => {
    const proc = Bun.spawn(
      [process.execPath, ...cliPrefix(), 'handoff', ...args],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  }
  const result = await exec([
    'plugin',
    'install',
    '--tool',
    tool,
    ...(dryRun ? ['--dry-run'] : []),
  ])
  return { root, config, log, result, exec }
}

test('plugin dry-run prints exact CLI commands without writing files or invoking tools', async () => {
  const h = await run('codex', true)
  expect(h.result.code).toBe(0)
  expect(h.result.stdout).toContain('codex plugin marketplace add ')
  expect(h.result.stdout).toContain('codex plugin add qianmo@qianmo')
  expect(fs.existsSync(h.config)).toBe(false)
  expect(fs.existsSync(h.log)).toBe(false)
})

for (const tool of ['codex', 'claude-code', 'omp'])
  test(`${tool}: embedded package installs from a local marketplace and repeat preserves existing files`, async () => {
    const h = await run(tool)
    expect(h.result).toMatchObject({ code: 0, stderr: '' })
    const directory = path.join(h.config, 'qianmo', 'plugin', 'qianmo')
    expect(fs.existsSync(path.join(directory, 'plugin.json'))).toBe(
      tool !== 'codex',
    )
    if (tool === 'codex')
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(directory, 'plugin.agent-plugins.json'),
            'utf8',
          ),
        ).$schema,
      ).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(fs.readFileSync(h.log, 'utf8').split('\n').filter(Boolean)).toEqual([
      `plugin marketplace add ${path.dirname(directory)}`,
      `plugin ${tool === 'codex' ? 'add' : 'install'} qianmo@qianmo`,
    ])
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(directory, '.codex-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as { name: string; hooks: readonly string[] }
    expect(manifest.hooks).toEqual(['./hooks/hooks.json'])
    const transport = JSON.parse(
      fs.readFileSync(path.join(directory, 'mcp.json'), 'utf8'),
    ) as {
      mcpServers: { qianmo: { type: string; command: string; args: string[] } }
    }
    expect(transport.mcpServers.qianmo).toEqual({
      type: 'stdio',
      command: 'qm',
      args: ['handoff', 'mcp'],
    })
    const file = path.join(directory, 'hooks', 'hooks.json')
    const before = fs.statSync(file).mtimeMs
    expect((await h.exec(['plugin', 'install', '--tool', tool])).code).toBe(0)
    expect(fs.statSync(file).mtimeMs).toBe(before)
    expect((await h.exec(['plugin', 'path'])).stdout.trim()).toBe(directory)
  })
