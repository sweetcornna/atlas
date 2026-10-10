// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { providerRuntime, chatStream } from './fixtures/provider-runtime.js'

test('native request builder preserves tool results across a tool turn', async () => {
  const f = await providerRuntime(
    (body, i) =>
      i === 0
        ? chatStream(
            body.model,
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ path: 'note.txt' }),
                  },
                },
              ],
            },
            'tool_calls',
          )
        : chatStream(body.model, { content: 'done' }),
    { compat: { supportsDeveloperRole: 'false' } },
  )
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(f.workspace, 'note.txt'), 'tool-result-canary')
  try {
    const p = f.pool()
    const id = await p.newSession({ agent: 'reviewer', cwd: f.workspace })
    const t = await f.turn(p, id, 'Read note.txt')
    expect(t.result.outcome).toBe('completed')
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1]!.body.messages)).toContain(
      'tool-result-canary',
    )
    for (const r of f.requests) {
      expect(r.body.model).toBe('native-test-model')
      expect(r.body.reasoning_effort).toBeUndefined()
      expect(
        (r.body.messages as { role: string }[]).some(
          m => m.role === 'developer',
        ),
      ).toBe(false)
    }
    expect(f.frames.some(f => f.type === 'tool_execution_end')).toBe(true)
  } finally {
    await f.dispose()
  }
}, 30000)

test('supportsDeveloperRole switches the actual native reasoning request role in both directions', async () => {
  for (const supportsDeveloperRole of [true, false]) {
    const f = await providerRuntime(undefined, {
      compat: { supportsDeveloperRole: String(supportsDeveloperRole) },
      models: [
        {
          id: 'native-test-reasoning-model',
          role: 'main',
          tiers: ['sonnet'],
          capabilities: {
            mode: 'explicit',
            thinking: true,
            adaptive_thinking: false,
            interleaved_thinking: false,
          },
          effort: { send: 'always', levels: ['low', 'high'], level: 'high' },
        },
      ],
    })
    try {
      const p = f.pool()
      const id = await p.newSession({ agent: 'reviewer', cwd: f.workspace })
      expect(
        (await f.turn(p, id, 'Check the request role')).result.outcome,
      ).toBe('completed')
      expect(f.requests).toHaveLength(1)
      const body = f.requests[0]!.body
      expect(body.model).toBe('native-test-reasoning-model')
      expect(body.reasoning_effort).toBe('high')
      const messages = body.messages as { role: string; content: unknown }[]
      const instructionRole = supportsDeveloperRole ? 'developer' : 'system'
      expect(messages[0]!.role).toBe(instructionRole)
      expect(messages[0]!.content).toBeTruthy()
      expect(
        messages.some(
          m => m.role === (supportsDeveloperRole ? 'system' : 'developer'),
        ),
      ).toBe(false)
    } finally {
      await f.dispose()
    }
  }
}, 30000)
