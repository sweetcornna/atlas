// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P32 end to end on a real qianmopi child: the node lays out an
 * operator-configured MCP server and skill, the probe names the server's
 * tools the way qianmopi does, and a resident turn offers and runs the tool
 * and reads the skill.
 */

import { expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'
import { NodeExtensions } from '../../src/host/extensions.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { INHERITED_ENV } from '../../src/host/runtimes/inheritedEnv.js'

test('a resident turn runs an operator-configured MCP tool and reads an installed skill', async () => {
  const previous = {
    config: process.env.QIANMO_CONFIG_DIR,
    path: process.env.PATH,
    home: process.env.HOME,
  }
  // Something of the node's own that no MCP server may see (P32 audit 9).
  process.env.QIANMO_TRANSPORT_PSK_E2E = 'node-secret'
  const root = mkdtempSync(join(tmpdir(), 'qm-ext-e2e-'))
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  // A skill of whoever the node runs as: never the agent's (P32).
  const home = join(root, 'home')
  mkdirSync(join(home, '.agents', 'skills', 'outsider'), { recursive: true })
  writeFileSync(
    join(home, '.agents', 'skills', 'outsider', 'SKILL.md'),
    "---\nname: outsider\ndescription: Not the operator's\n---\nOUTSIDER-MARKER\n",
  )
  process.env.HOME = home
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // A bare command on PATH, as the console requires.
  writeFileSync(
    join(bin, 'tiny-mcp'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, 'fixtures', 'tiny-mcp.runner.ts')}'\n`,
  )
  chmodSync(join(bin, 'tiny-mcp'), 0o755)
  process.env.PATH = `${bin}:${process.env.PATH}`
  const envLog = join(root, 'mcp-env.jsonl')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const harness = new ResidentOmpHarness()
  const extensions = new NodeExtensions({
    agents: [{ agent: 'reviewer' }],
    root: join(root, 'config', 'extensions'),
  })
  let pool: ResidentOmpPool | undefined
  try {
    const applied = await extensions.apply([
      {
        id: 'ext-00000000-0000-4000-8000-000000000001',
        kind: 'mcp',
        name: 'docs',
        agents: null,
        transport: 'stdio',
        command: 'tiny-mcp',
        env: { DOCS_TOKEN: 'token-1', TINY_MCP_ENV_LOG: envLog },
        approval: 'allow',
      },
      {
        id: 'ext-00000000-0000-4000-8000-000000000002',
        kind: 'skill',
        name: 'review',
        agents: null,
        description: 'Review a draft',
        body: 'SKILL-BODY-MARKER read the draft twice',
      },
    ])
    expect(applied.ok).toBe(true)
    const tool = 'mcp__qianmo_mcp_docs_search'
    expect(extensions.forAgent('reviewer')!.mcp[0]!.tools).toEqual([tool])
    harness.script([
      { name: tool, input: { q: 'cache' } },
      { name: 'read', input: { path: 'skill://review' } },
      { name: 'read', input: { path: 'skill://outsider' } },
    ])
    pool = new ResidentOmpPool({
      agents: [{ agent: 'reviewer', cwd: workspace }],
      memoryRoot: join(root, 'memory'),
      announce: async () => ({ status: 'queued' }),
      extensions: agent => extensions.forAgent(agent),
    })
    const sessionId = await pool.newSession({
      agent: 'reviewer',
      cwd: workspace,
    })
    const result = await new OmpResidentTurnPort(pool).execute(
      { sessionId, messageId: 'ext-e2e', prompt: 'Use the docs.' },
      async () => {},
    )
    expect(result.outcome).toBe('completed')
    expect(harness.offeredTools.has(tool)).toBe(true)
    expect(harness.toolResults[0]).toContain('found: cache (token-1)')
    expect(harness.toolResults[1]).toContain('SKILL-BODY-MARKER')
    expect(harness.toolResults[2]).not.toContain('OUTSIDER-MARKER')
    // The probe and qianmopi's own start both went through qm mcp-exec: the
    // server saw its own variables and the baseline, not the node's.
    const seen = readFileSync(envLog, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
    expect(seen).toHaveLength(2)
    for (const names of seen) {
      expect(names).toContain('DOCS_TOKEN')
      expect(names).toContain('PATH')
      expect(names).not.toContain('QIANMO_TRANSPORT_PSK_E2E')
      expect(names).not.toContain('QIANMO_CONFIG_DIR')
      // PWD and SHLVL are the fixture's own shell script's.
      expect(
        names
          .filter(name => !INHERITED_ENV.includes(name))
          .filter(name => name !== 'PWD' && name !== 'SHLVL')
          .sort(),
      ).toEqual(['DOCS_TOKEN', 'TINY_MCP_ENV_LOG'])
    }
  } finally {
    await pool?.stop()
    await harness.stop()
    process.env.PATH = previous.path
    process.env.HOME = previous.home
    delete process.env.QIANMO_TRANSPORT_PSK_E2E
    if (previous.config === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous.config
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
