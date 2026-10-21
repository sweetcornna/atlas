// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P39 against a real qianmopi child: the grant changes what the child is
 * offered and what it may do, every elevated call reaches the host gate, and
 * a revoke takes it all back. No call here leaves the machine: the only URL
 * read is a local server, and the one call that would ask the operator is
 * refused.
 */

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthzCall } from '@qianmo/resident'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeElevation } from '../../src/host/elevation.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import {
  ResidentOmpHarness,
  type ScriptedCall,
} from '../../../../tests/integration/fixtures/resident-omp-harness.js'

let root: string | undefined
let previous: string | undefined
let harness: ResidentOmpHarness | undefined
let pool: ResidentOmpPool | undefined
let elevation: NodeElevation | undefined
let page: ReturnType<typeof Bun.serve> | undefined
afterEach(async () => {
  await pool?.stop()
  elevation?.close()
  await harness?.stop()
  await page?.stop(true)
  if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previous
  if (root) rmSync(root, { recursive: true, force: true })
  root = pool = elevation = harness = page = undefined
})

test('real qianmopi: a grant opens workspace edits and a public-URL read through the gate, accept-edits asks, revoke takes it back', async () => {
  root = mkdtempSync(join(tmpdir(), 'qm-elevation-real-'))
  previous = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  page = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('local page body P39-MARKER', {
        headers: { 'Content-Type': 'text/plain' },
      }),
  })
  // The read goes by name; the stand-in DNS below answers that name with a
  // public address, so the host guard lets it through to the local page. The
  // literal loopback address needs no DNS and is refused.
  const url = `http://localhost:${page.port}/probe.txt`
  const loopback = `http://127.0.0.1:${page.port}/probe.txt`
  const h = new ResidentOmpHarness()
  harness = h
  // gh decides whether the base registers `github`; mirror this machine.
  const hasGh = Bun.which('gh') !== null
  const gates: Record<string, unknown>[] = []
  const asked: AuthzCall[] = []
  const e = new NodeElevation({
    node: 'n1',
    agents: ['reviewer'],
    estop: () => false,
    workspace: () => workspace,
    // No sandbox on any platform here: bash stays off, as on macOS.
    platform: 'darwin',
    bwrap: {
      available: program => program === 'gh' && hasGh,
      probe: async () => false,
      shell: () => '/bin/sh',
    },
    lookup: async host => {
      if (host !== 'localhost') throw new Error('ENOTFOUND')
      return [{ address: '93.184.215.14' }]
    },
    changed: async agent => pool?.invalidateAgent(agent),
    terminate: async agent => pool?.retireAgent(agent),
  })
  elevation = e
  const p = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: workspace }],
    memoryRoot: join(root, 'memory'),
    allowWorkspaceEdits: false,
    announce: async () => ({ status: 'queued' }),
    elevation: e,
    requestElevation: async (_sessionId, call) => {
      gates.push(call as Record<string, unknown>)
      const decision = await e.decide(
        'reviewer',
        'task-1',
        'ctx-1',
        call,
        () => true,
        async request => {
          asked.push(request)
          return false
        },
      )
      return decision.ok
    },
  })
  pool = p
  const turn = new OmpResidentTurnPort(p, {
    inactivity: { timeoutMs: 20_000 },
  })
  async function run(steps: readonly ScriptedCall[]) {
    h.script(steps)
    h.offeredTools.clear()
    h.toolResults.length = 0
    gates.length = 0
    asked.length = 0
    const sessionId = await p.newSession({ agent: 'reviewer', cwd: workspace })
    const result = await turn.execute(
      {
        sessionId,
        messageId: `input-${Math.random()}`,
        prompt: 'Run the scripted acceptance case.',
      },
      async () => {},
    )
    return {
      result,
      offered: [...h.offeredTools],
      results: [...h.toolResults],
    }
  }
  const control = (op: string, args: Record<string, unknown>) => {
    const operationId = `op-${Math.random()}`
    return e.control(
      op,
      { agent: 'reviewer', operationId, ...args },
      { actor: 'u:op', peer: 'console', taskId: operationId },
    )
  }

  // 1. 人工确认 (off): no edits, no network tools, the URL read refused.
  const off = await run([
    { name: 'write', input: { path: 'off.txt', content: 'no' } },
    { name: 'read', input: { path: url } },
  ])
  // The model did see a tool list: the absences below are not vacuous.
  expect(off.offered).toContain('read')
  expect(off.offered).not.toContain('write')
  expect(off.offered).not.toContain('web_search')
  expect(existsSync(join(workspace, 'off.txt'))).toBe(false)
  expect(off.results.join('\n')).not.toContain('P39-MARKER')
  expect(gates).toEqual([])

  // 2. 自动审批 (auto): workspace edits and the URL read run without asking;
  // a read of this machine's own address is refused by the host guard.
  expect((await control('elevation.enable', { tier: 'auto' })).ok).toBe(true)
  const auto = await run([
    { name: 'write', input: { path: 'auto.txt', content: 'yes' } },
    { name: 'read', input: { path: loopback } },
    { name: 'read', input: { path: url } },
  ])
  expect(auto.offered).toEqual(
    expect.arrayContaining(['write', 'edit', 'web_search']),
  )
  expect(auto.offered).not.toContain('bash')
  expect(auto.offered.includes('github')).toBe(hasGh)
  expect(existsSync(join(workspace, 'auto.txt'))).toBe(true)
  expect(auto.results.join('\n')).toContain('P39-MARKER')
  expect(auto.results.join('\n')).toContain('the node refused this call')
  const phases = gates.map(
    g =>
      `${String(g.toolName)}:${String((g.input as { phase?: unknown }).phase)}`,
  )
  expect(phases).toEqual(['read:authorize', 'read:authorize', 'read:completed'])
  expect(asked).toEqual([])
  const actions = await e.control(
    'elevation.actions',
    { agent: 'reviewer' },
    { actor: 'u:op', peer: 'console', taskId: 'read-actions' },
  )
  expect(actions.ok).toBe(true)
  const rows = (actions.ok ? actions.value : []) as {
    tool: string
    cls: string
    outcome: string
    host?: string
  }[]
  expect(
    rows.map(r => `${r.tool}:${r.cls}:${r.outcome}:${r.host ?? ''}`),
  ).toEqual([
    'read:read-out:completed:localhost',
    'read:read-out:allowed:localhost',
    'read:read-out:refused:127.0.0.1',
  ])

  // 3. 自动接受编辑 (accept-edits): the same read now asks, and a refusal blocks it.
  expect((await control('elevation.enable', { tier: 'accept-edits' })).ok).toBe(
    true,
  )
  const edits = await run([
    { name: 'write', input: { path: 'edits.txt', content: 'yes' } },
    { name: 'read', input: { path: url } },
  ])
  expect(existsSync(join(workspace, 'edits.txt'))).toBe(true)
  expect(gates.map(g => String(g.toolName))).toEqual(['read'])
  expect(asked.map(a => a.toolName)).toEqual(['qianmo_elevated_read'])
  expect(edits.results.join('\n')).not.toContain('P39-MARKER')
  expect(edits.results.join('\n')).toContain('the node refused this call')

  // 4. Revoke: back to 人工确认 at once, the next child is offered nothing extra.
  expect((await control('elevation.revoke', {})).ok).toBe(true)
  const revoked = await run([
    { name: 'write', input: { path: 'revoked.txt', content: 'no' } },
  ])
  expect(revoked.offered).toContain('read')
  expect(revoked.offered).not.toContain('write')
  expect(revoked.offered).not.toContain('web_search')
  expect(existsSync(join(workspace, 'revoked.txt'))).toBe(false)
}, 120_000)
