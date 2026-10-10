// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore } from '@qianmo/memory'
import { INSUFFICIENT_MEMORY_ANSWER, recall } from '@qianmo/recall'
import {
  OmpResidentTurnPort,
  ResidentMemorySidecar,
  residentMemoryScope,
} from '@qianmo/resident'
import { answerPrompt } from '../../../recall/eval/answer/protocol.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

test('real OMP uses the v2 source contract, rejects false support and emits only host-verified excerpts or limited refusal', async () => {
  const before = process.env.QIANMO_CONFIG_DIR
  const root = mkdtempSync(join(tmpdir(), 'qm-memory-evidence-'))
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const store = new FileMemoryStore({ root: join(root, 'memory') })
  const scope = { agent: 'reviewer', contextId: 'evidence-quality' }
  const entry = store.write({
    scope: residentMemoryScope(scope),
    title: 'Terminal updates',
    summary: 'Unattended terminals stay offline.',
    body: 'Do not enable remote updates on unattended terminals.',
    source: { kind: 'user', id: 'test-operator' },
  })
  const asOf = new Date()
  const sidecar = new ResidentMemorySidecar({ store, now: () => asOf })
  const question = 'What is the update rule for unattended terminals?'
  const frozen = sidecar.renderFrozen(scope, question)
  const evaluated = answerPrompt(
    'memory-evidence-v2',
    recall(store, { scope: residentMemoryScope(scope), question, asOf }),
    question,
  )
  expect(evaluated.system).toEqual([])
  expect(evaluated.turns).toEqual([
    { role: 'user', text: `${question}\n\n${frozen.block}` },
  ])
  const harness = new ResidentOmpHarness()
  let turn: OmpResidentTurnPort
  const pool = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: workspace }],
    memoryRoot: store.root,
    announce: async () => ({ status: 'queued' }),
    memoryAnswer: (sessionId, args) => turn.memoryAnswer(sessionId, args),
  })
  harness.pools.push(pool)
  turn = new OmpResidentTurnPort(pool, {
    inactivity: { timeoutMs: 10_000 },
    memoryAnswer: (input, args) => sidecar.answer(input.memoryIds ?? [], args),
  })
  try {
    const sessionId = await pool.newSession({
      agent: 'reviewer',
      cwd: workspace,
    })
    harness.script([
      {
        name: 'qianmo_memory_answer',
        input: {
          status: 'supported',
          evidence: [
            {
              id: entry.id,
              quote: 'Enable remote updates on unattended terminals.',
            },
          ],
        },
      },
      {
        name: 'qianmo_memory_answer',
        input: {
          status: 'insufficient',
          evidence: [{ id: entry.id, quote: entry.summary }],
        },
      },
      {
        name: 'qianmo_memory_answer',
        input: {
          status: 'supported',
          evidence: [{ id: entry.id, quote: entry.body }],
          answer: 'Invented free assertion',
        },
      },
      {
        name: 'qianmo_memory_answer',
        input: {
          status: 'supported',
          evidence: [{ id: entry.id, quote: entry.body }],
        },
      },
    ])
    const result = await turn.execute(
      {
        sessionId,
        messageId: 'source-positive',
        prompt: `${question}\n\n${frozen.block}`,
        memoryIds: frozen.memoryIds,
      },
      async () => {},
    )
    expect(result).toMatchObject({ outcome: 'completed' })
    if (result.outcome !== 'completed') throw new Error(result.reason)
    expect(result.content).toContain(`> ${entry.body}`)
    expect(result.content).toContain(entry.id)
    expect(result.content).not.toContain('Invented free assertion')
    expect(result.content).not.toContain('pong')
    expect(
      harness.toolResults.some(text => text.includes('could not be verified')),
    ).toBe(true)
    expect(
      harness.toolResults.some(text => text.includes('Invalid memory answer')),
    ).toBe(true)
    harness.script([
      {
        name: 'qianmo_memory_answer',
        input: { status: 'insufficient', evidence: [] },
      },
    ])
    const refusal = await turn.execute(
      {
        sessionId,
        messageId: 'source-negative',
        prompt: `Was an unrecorded exception approved?\n\n${frozen.block}`,
        memoryIds: frozen.memoryIds,
      },
      async () => {},
    )
    expect(refusal).toMatchObject({
      outcome: 'completed',
      content: INSUFFICIENT_MEMORY_ANSWER,
    })
    expect(harness.offeredTools.has('qianmo_memory_answer')).toBe(true)
  } finally {
    await harness.stop()
    if (before === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = before
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
