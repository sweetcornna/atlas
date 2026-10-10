// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export function isolatedRoot() {
  const previous = process.env.QIANMO_CONFIG_DIR
  const root = mkdtempSync(join(tmpdir(), 'omp-port-ModelService-'))
  chmodSync(root, 0o700)
  process.env.QIANMO_CONFIG_DIR = root
  return {
    root,
    dispose() {
      if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
      else process.env.QIANMO_CONFIG_DIR = previous
      rmSync(root, { recursive: true, force: true })
    },
  }
}
export function fakeOpenAI(status = 200) {
  const requests: {
    path: string
    headers: Headers
    body: Record<string, unknown>
  }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST')
        return Response.json({ data: [{ id: 'vendor-model-pro' }] })
      const body = (await req.json()) as Record<string, unknown>
      requests.push({
        path: new URL(req.url).pathname,
        headers: req.headers,
        body,
      })
      if (status !== 200)
        return Response.json(
          {
            error: {
              message: 'rejected secret-do-not-echo',
              type: 'invalid_request_error',
            },
          },
          { status, headers: { 'retry-after': '0' } },
        )
      const base = {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
      }
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'OK' },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          ...base,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ]
      return new Response(
        chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    stop: () => server.stop(true),
  }
}
