// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Steering a running turn on a real qianmopi RPC child (P38): the host's
 * `prompt` with `streamingBehavior: 'steer'` reaches the model at the next
 * step, completes with a `prompt_result` of its own, and the turn's answer
 * covers both prompts — the session never runs a run nobody waits for.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpResidentTurnPort, type OmpRpcFrame } from '@qianmo/resident'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

let root: string | undefined
const previous = process.env.QIANMO_CONFIG_DIR
let harness: ResidentOmpHarness | undefined

afterEach(async () => {
  await harness?.stop()
  harness = undefined
  if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previous
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

function userTexts(frames: readonly OmpRpcFrame[]): string[] {
  return frames.flatMap(frame => {
    if (frame.type !== 'message_end') return []
    const message = frame.message as
      | { role?: string; content?: unknown }
      | undefined
    if (message?.role !== 'user') return []
    const content = message.content
    if (typeof content === 'string') return [content]
    return Array.isArray(content)
      ? content.flatMap(part =>
          typeof part === 'object' &&
          part !== null &&
          typeof (part as { text?: unknown }).text === 'string'
            ? [(part as { text: string }).text]
            : [],
        )
      : []
  })
}

test('real omp RPC: a steer reaches the running turn, and the turn ends after both prompts', async () => {
  root = mkdtempSync(join(tmpdir(), 'qm-steer-'))
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  harness = new ResidentOmpHarness()
  harness.script([])
  const pool = new ResidentOmpPool({
    agents: [{ agent: 'reviewer', cwd: workspace }],
    memoryRoot: join(root, 'memory'),
    announce: async () => ({ status: 'queued' }),
  })
  harness.pools.push(pool)
  const sessionId = await pool.newSession({ agent: 'reviewer', cwd: workspace })
  const channel = await pool.channelFor(sessionId)
  const frames: OmpRpcFrame[] = []
  channel.onFrame(frame => frames.push(frame))
  const turn = new OmpResidentTurnPort(pool, {
    inactivity: { timeoutMs: 30_000 },
  })
  // The model answers only when the test says so: the steer lands while
  // the turn waits for it.
  const release = harness.pauseResponses()
  let accepted = false
  const result = turn.execute(
    {
      sessionId,
      messageId: `input-${Date.now()}`,
      networkMsgId: 'network-steer',
      prompt: 'First question.',
    },
    async () => {
      accepted = true
    },
  )
  await until(() => accepted)
  // Durable, not yielded: the turn takes more input.
  expect(await turn.steer('network-other', 'nobody')).toBe('not_running')
  expect(await turn.steer('network-steer', 'One more thing.')).toBe('steered')
  release()
  const answer = await result
  expect(answer).toEqual({ outcome: 'completed', content: 'pong\n\npong' })
  // Both inputs reached the model's transcript, the steered one after the
  // first, and two prompt results came back: the turn waited for both.
  expect(userTexts(frames)).toEqual(['First question.', 'One more thing.'])
  expect(frames.filter(frame => frame.type === 'prompt_result')).toHaveLength(2)
  // Over: nothing more goes in, and the session is idle for the next turn.
  expect(await turn.steer('network-steer', 'late')).toBe('not_running')
  const state = await channel.request('get_state')
  expect(
    (state.data as { isStreaming?: boolean } | undefined)?.isStreaming,
  ).toBe(false)
}, 60_000)
