// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { OmpResidentTurnPort } from '@qianmo/resident'

test('explicit protected root inside workspace blocks actual native read/write while ordinary writes succeed', async () => {
  const previous = process.env.QIANMO_CONFIG_DIR
  const root = mkdtempSync(join(tmpdir(), 'qm-protected-root-'))
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace'),
    protectedRoot = join(workspace, 'hub-secrets')
  mkdirSync(protectedRoot, { recursive: true })
  const canary = 'PRIVATE-CANARY-DO-NOT-LEAK'
  writeFileSync(join(protectedRoot, 'secret.txt'), canary)
  const harness = new ResidentOmpHarness()
  harness.script([
    { name: 'read', input: { path: join(protectedRoot, 'secret.txt') } },
    {
      name: 'write',
      input: { path: join(protectedRoot, 'changed.txt'), content: 'forbidden' },
    },
    {
      name: 'write',
      input: {
        path: join(workspace, 'allowed.txt'),
        content: 'positive control',
      },
    },
  ])
  const pool = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: workspace }],
    allowWorkspaceEdits: true,
    memoryRoot: join(root, 'memory'),
    protectedRoots: [protectedRoot],
    announce: async () => ({ status: 'queued' }),
  })
  try {
    const sessionId = await pool.newSession({
      agent: 'reviewer',
      cwd: workspace,
    })
    const port = new OmpResidentTurnPort(pool)
    expect(
      (
        await port.execute(
          {
            sessionId,
            messageId: 'protected-root',
            prompt: 'Perform the scripted actions.',
          },
          async () => {},
        )
      ).outcome,
    ).toBe('completed')
    expect(readFileSync(join(workspace, 'allowed.txt'), 'utf8')).toBe(
      'positive control',
    )
    expect(existsSync(join(protectedRoot, 'changed.txt'))).toBe(false)
    expect(readFileSync(join(protectedRoot, 'secret.txt'), 'utf8')).toBe(canary)
    expect(harness.toolResults.join('\n')).not.toContain(canary)
    expect(
      harness.toolResults
        .slice(0, 2)
        .every(result => /blocked|protected|memory store/i.test(result)),
    ).toBe(true)
  } finally {
    await pool.stop()
    await harness.stop()
    if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous
  }
}, 30_000)
