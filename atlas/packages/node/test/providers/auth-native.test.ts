// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { ompChildEnv } from '@qianmo/paths'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'
import { ompArgv } from '../../src/omp/launch.js'
import { computeEffectiveProviderState } from '../../src/providers/effective.js'
import { isolatedRoot, fakeOpenAI } from './fake.js'
import { applyRequest, CANARY_KEY, CANARY_KEY_2 } from './helpers.js'

for (const { lane, scheme, pool } of [
  { lane: 'openai-chat', scheme: 'bearer', pool: true },
  { lane: 'anthropic', scheme: 'bearer', pool: true },
  { lane: 'anthropic', scheme: 'x-api-key', pool: false },
] as const)
  test(`omp uses native API-key ${pool ? 'pool' : 'single'} on ${lane} ${scheme} without OAuth request shaping`, async () => {
    const fixture = isolatedRoot()
    const headers: Headers[] = []
    const bodies: Record<string, unknown>[] = []
    const chat = lane === 'openai-chat' ? fakeOpenAI() : undefined
    const server =
      lane === 'anthropic'
        ? Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            async fetch(req) {
              headers.push(req.headers)
              bodies.push((await req.json()) as Record<string, unknown>)
              const events = [
                [
                  'message_start',
                  {
                    type: 'message_start',
                    message: {
                      id: 'msg-test',
                      type: 'message',
                      role: 'assistant',
                      model: 'vendor-model-pro',
                      content: [],
                      stop_reason: null,
                      stop_sequence: null,
                      usage: { input_tokens: 10, output_tokens: 0 },
                    },
                  },
                ],
                [
                  'content_block_start',
                  {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' },
                  },
                ],
                [
                  'content_block_delta',
                  {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'OK' },
                  },
                ],
                [
                  'content_block_stop',
                  { type: 'content_block_stop', index: 0 },
                ],
                [
                  'message_delta',
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { output_tokens: 2 },
                  },
                ],
                ['message_stop', { type: 'message_stop' }],
              ]
              return new Response(
                events
                  .map(
                    ([kind, data]) =>
                      `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`,
                  )
                  .join(''),
                { headers: { 'content-type': 'text/event-stream' } },
              )
            },
          })
        : undefined
    try {
      const req = applyRequest({
        profile: {
          lane,
          compat:
            lane === 'anthropic'
              ? {
                  supportsReasoningEffort: 'false',
                  supportsReasoningParams: 'false',
                }
              : {},
          baseUrl: chat?.baseUrl ?? `http://127.0.0.1:${server!.port}`,
          auth: {
            scheme,
            keys: [
              { id: 'a', value: CANARY_KEY },
              ...(pool ? [{ id: 'b', value: CANARY_KEY_2 }] : []),
            ],
          },
          models: [
            {
              id: 'vendor-model-pro',
              role: 'main',
              tiers: ['sonnet'],
              capabilities: {
                mode: 'explicit',
                thinking: lane === 'anthropic' && pool,
                adaptive_thinking: false,
                interleaved_thinking: false,
              },
              effort:
                lane === 'anthropic' && pool
                  ? { send: 'always', levels: ['low', 'high'], level: 'high' }
                  : { send: 'never' },
            },
          ],
        },
      })
      expect(stageProviderApply(req).ok).toBe(true)
      expect((await commitPendingProviderConfig()).status).toBe('committed')
      const child = Bun.spawn(
        ompArgv([
          '-p',
          '--mode',
          'json',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-title',
          'Reply OK',
        ]),
        {
          cwd: fixture.root,
          env: ompChildEnv(process.env),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const timer = setTimeout(() => child.kill(), 15000)
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      expect(code).toBe(0)
      expect(err).not.toContain(CANARY_KEY)
      const messages = out
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(
          e => e.type === 'message_end' && e.message?.role === 'assistant',
        )
      expect(messages).toHaveLength(1)
      expect(messages[0].message.stopReason).not.toBe('error')
      const h = chat?.requests[0]?.headers ?? headers[0]!
      expect(h).toBeDefined()
      if (scheme === 'x-api-key') {
        expect(h.get('x-api-key')).toBe(CANARY_KEY)
        expect(h.get('authorization')).toBeNull()
      } else
        expect([`Bearer ${CANARY_KEY}`, `Bearer ${CANARY_KEY_2}`]).toContain(
          h.get('authorization') ?? '',
        )
      expect(h.get('user-agent') ?? '').not.toMatch(/^claude-cli/i)
      expect(h.get('anthropic-beta') ?? '').not.toContain('oauth')
      if (lane === 'anthropic') {
        const effective = await computeEffectiveProviderState()
        expect(effective.effortOnWire).toBe(pool)
        expect(effective.effortLevel).toBe(pool ? 'high' : null)
        if (pool) {
          expect(bodies[0]!.thinking).toMatchObject({ type: 'enabled' })
          expect(
            (bodies[0]!.thinking as { budget_tokens: number }).budget_tokens,
          ).toBeGreaterThan(0)
        } else expect(bodies[0]!.thinking).toBeUndefined()
      }
    } finally {
      chat?.stop()
      server?.stop(true)
      fixture.dispose()
    }
  }, 25000)
