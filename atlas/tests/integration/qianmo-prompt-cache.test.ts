// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { providerRuntime, chatStream } from './fixtures/provider-runtime.js'

test('native session history and cache telemetry survive child replacement; other sessions do not contaminate it', async () => {
  const f = await providerRuntime((b, i) =>
    chatStream(b.model, { content: `answer-${i}` }, 'stop', i ? 80 : 0),
  )
  try {
    const pool = f.pool()
    const a = await pool.newSession({ agent: 'reviewer', cwd: f.workspace })
    expect((await f.turn(pool, a, 'CACHE-A-ONE')).result.outcome).toBe(
      'completed',
    )
    expect((await f.turn(pool, a, 'CACHE-A-TWO')).result.outcome).toBe(
      'completed',
    )
    const b = await pool.newSession({ agent: 'reviewer', cwd: f.workspace })
    expect((await f.turn(pool, b, 'CACHE-B-ONLY')).result.outcome).toBe(
      'completed',
    )
    await pool.stop()
    const resumed = f.pool()
    await resumed.resumeSession({
      agent: 'reviewer',
      cwd: f.workspace,
      sessionId: a,
    })
    expect((await f.turn(resumed, a, 'CACHE-A-THREE')).result.outcome).toBe(
      'completed',
    )
    expect(f.requests).toHaveLength(4)
    const messages = f.requests.map(r => r.body.messages as unknown[])
    expect(messages[1]!.slice(0, messages[0]!.length)).toEqual(messages[0]!)
    expect(messages[3]!.slice(0, messages[1]!.length)).toEqual(messages[1]!)
    expect(JSON.stringify(messages[2])).not.toContain('CACHE-A-ONE')
    expect(JSON.stringify(messages[3])).not.toContain('CACHE-B-ONLY')
    const usage = f.frames
      .filter(f => f.type === 'message_end')
      .map(f => (f.message as { usage?: { cacheRead?: number } }).usage)
    expect(usage.some(u => u?.cacheRead === 80)).toBe(true)
    for (const req of f.requests) {
      expect(req.body.previous_response_id).toBeUndefined()
      expect(req.body.prompt_cache_retention).toBeUndefined()
    }
  } finally {
    await f.dispose()
  }
}, 45000)
