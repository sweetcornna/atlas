// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { ompChildEnv } from '@qianmo/paths'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'
import { ompArgv } from '../../src/omp/launch.js'
import { isolatedRoot, fakeOpenAI } from './fake.js'
import { applyRequest, CANARY_KEY, CANARY_KEY_2 } from './helpers.js'

for (const lane of ['openai-responses', 'gemini', 'grok'] as const)
  test(`native ${lane} request consumes compiled model and stored API key pool`, async () => {
    const f = isolatedRoot()
    const seen: {
      url: URL
      headers: Headers
      body: Record<string, unknown>
    }[] = []
    const chat = lane === 'grok' ? fakeOpenAI() : undefined
    const server = chat
      ? undefined
      : Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(req) {
            const body = (await req.json()) as Record<string, unknown>
            seen.push({ url: new URL(req.url), headers: req.headers, body })
            const data =
              lane === 'gemini'
                ? [
                    {
                      candidates: [
                        {
                          content: { parts: [{ text: 'OK' }], role: 'model' },
                          finishReason: 'STOP',
                          index: 0,
                        },
                      ],
                      usageMetadata: {
                        promptTokenCount: 10,
                        candidatesTokenCount: 1,
                        totalTokenCount: 11,
                      },
                    },
                  ]
                : [
                    {
                      type: 'response.output_item.added',
                      item: {
                        type: 'message',
                        id: 'msg_1',
                        role: 'assistant',
                        status: 'in_progress',
                        content: [],
                      },
                    },
                    {
                      type: 'response.content_part.added',
                      part: { type: 'output_text', text: '' },
                    },
                    { type: 'response.output_text.delta', delta: 'OK' },
                    {
                      type: 'response.output_item.done',
                      item: {
                        type: 'message',
                        id: 'msg_1',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: 'OK' }],
                      },
                    },
                    {
                      type: 'response.completed',
                      response: {
                        id: 'resp_1',
                        status: 'completed',
                        usage: {
                          input_tokens: 10,
                          output_tokens: 1,
                          total_tokens: 11,
                          input_tokens_details: { cached_tokens: 0 },
                        },
                      },
                    },
                  ]
            return new Response(
              data.map(d => `data: ${JSON.stringify(d)}\n\n`).join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            )
          },
        })
    try {
      const baseUrl =
        chat?.baseUrl ??
        `http://127.0.0.1:${server!.port}${lane === 'gemini' ? '/v1beta' : '/v1'}`
      const result = stageProviderApply(
        applyRequest({
          profile: {
            lane,
            baseUrl,
            compat: {},
            auth: {
              scheme: 'bearer',
              keys: [
                { id: 'a', value: CANARY_KEY },
                { id: 'b', value: CANARY_KEY_2 },
              ],
            },
            models: [
              {
                id: 'wire-test',
                role: 'main',
                tiers: ['sonnet'],
                capabilities: {
                  mode: 'explicit',
                  thinking: false,
                  adaptive_thinking: false,
                  interleaved_thinking: false,
                },
                effort: { send: 'never' },
              },
            ],
          },
        }),
      )
      expect(result.ok).toBe(true)
      expect((await commitPendingProviderConfig()).status).toBe('committed')
      const proc = Bun.spawn(
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
          cwd: f.root,
          env: ompChildEnv(process.env),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const timer = setTimeout(() => proc.kill(), 15000)
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(timer)
      expect(code).toBe(0)
      expect(err).not.toContain(CANARY_KEY)
      const end = out
        .split('\n')
        .filter(Boolean)
        .map(s => JSON.parse(s))
        .filter(
          e => e.type === 'message_end' && e.message?.role === 'assistant',
        )
      expect(end).toHaveLength(1)
      expect(end[0].message.stopReason).toBe('stop')
      if (lane === 'gemini') {
        expect(seen[0]?.url.pathname).toContain(
          '/models/wire-test:streamGenerateContent',
        )
        expect([CANARY_KEY, CANARY_KEY_2]).toContain(
          seen[0]?.headers.get('x-goog-api-key') ?? '',
        )
      } else {
        const r = chat?.requests[0] ?? seen[0]!
        expect(r.body.model).toBe('wire-test')
        expect([`Bearer ${CANARY_KEY}`, `Bearer ${CANARY_KEY_2}`]).toContain(
          r.headers.get('authorization') ?? '',
        )
        expect(r.body.previous_response_id).toBeUndefined()
      }
    } finally {
      chat?.stop()
      server?.stop(true)
      f.dispose()
    }
  }, 20000)
