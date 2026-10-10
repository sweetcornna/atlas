// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { providerRuntime, chatStream } from './fixtures/provider-runtime.js'
import { turnFailureKind } from '@qianmo/resident'
for (const content of ['', '   '])
  test(`empty model completion ${JSON.stringify(content)} never becomes successful task result`, async () => {
    const f = await providerRuntime(b => chatStream(b.model, { content }))
    try {
      const pool = f.pool()
      const id = await pool.newSession({ agent: 'reviewer', cwd: f.workspace })
      const turn = await f.turn(pool, id, 'Answer the task')
      expect(turn.accepted).toBe(true)
      expect(f.requests.length).toBeGreaterThan(0)
      expect(turn.result.outcome).toBe('failed')
      if (turn.result.outcome === 'failed')
        expect(turnFailureKind(turn.result.reason)).toBe('model_empty_response')
    } finally {
      await f.dispose()
    }
  }, 30000)
test('nonempty answer is completed, upstream HTTP failure stays a failure', async () => {
  let reject = false
  const f = await providerRuntime(b =>
    reject
      ? Response.json({ error: { message: 'test failure' } }, { status: 401 })
      : chatStream(b.model, { content: 'visible reply' }),
  )
  try {
    const pool = f.pool()
    const id = await pool.newSession({ agent: 'reviewer', cwd: f.workspace })
    expect((await f.turn(pool, id, 'First')).result).toMatchObject({
      outcome: 'completed',
      content: 'visible reply',
    })
    reject = true
    const failed = await f.turn(pool, id, 'Second')
    expect(failed.result.outcome).toBe('failed')
    if (failed.result.outcome === 'failed')
      expect(turnFailureKind(failed.result.reason)).toBe('model_error')
  } finally {
    await f.dispose()
  }
}, 30000)
